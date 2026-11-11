#include <jni.h>
#include <android/log.h>
#include <llama.h>
#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>
#include <cstring>
#include <dlfcn.h>

#define AXIOM_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "AxiomLLM", __VA_ARGS__)

static std::mutex g_model_mutex;
static llama_model * g_model = nullptr;
static llama_context * g_context = nullptr;
static llama_sampler * g_sampler = nullptr;
static std::string g_loaded_path;

static void release_model_locked() {
    if (g_sampler) { llama_sampler_free(g_sampler); g_sampler = nullptr; }
    if (g_context) { llama_free(g_context); g_context = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_loaded_path.clear();
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaLoadModel(JNIEnv * env, jobject, jstring path, jint context_size, jint threads) {
    const char * raw_path = env->GetStringUTFChars(path, nullptr);
    if (!raw_path) return JNI_FALSE;
    std::string model_path(raw_path);
    env->ReleaseStringUTFChars(path, raw_path);

    std::lock_guard<std::mutex> lock(g_model_mutex);
    if (g_loaded_path == model_path && g_context) return JNI_TRUE;
    release_model_locked();

    llama_backend_init();
    llama_model_params model_params = llama_model_default_params();
    model_params.use_mmap = true;
    model_params.use_mlock = false;
    g_model = llama_model_load_from_file(model_path.c_str(), model_params);
    if (!g_model) {
        AXIOM_LOGE("Failed to load GGUF model: %s", model_path.c_str());
        return JNI_FALSE;
    }

    llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = static_cast<uint32_t>(std::clamp(context_size, 512, 8192));
    context_params.n_batch = 512;
    context_params.n_threads = std::clamp(threads, 1, 16);
    context_params.n_threads_batch = context_params.n_threads;
    g_context = llama_init_from_model(g_model, context_params);
    if (!g_context) {
        AXIOM_LOGE("Failed to create llama context");
        release_model_locked();
        return JNI_FALSE;
    }

    llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
    g_sampler = llama_sampler_chain_init(sampler_params);
    llama_sampler_chain_add(g_sampler, llama_sampler_init_temp(0.7f));
    llama_sampler_chain_add(g_sampler, llama_sampler_init_dist(0xA710ULL));
    g_loaded_path = model_path;
    return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaUnloadModel(JNIEnv *, jobject) {
    std::lock_guard<std::mutex> lock(g_model_mutex);
    release_model_locked();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaLoadedModel(JNIEnv * env, jobject) {
    std::lock_guard<std::mutex> lock(g_model_mutex);
    return env->NewStringUTF(g_loaded_path.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaGenerate(JNIEnv * env, jobject, jstring prompt, jint max_tokens, jobject callback) {
    const char * raw_prompt = env->GetStringUTFChars(prompt, nullptr);
    if (!raw_prompt) return env->NewStringUTF("");
    const std::string prompt_text(raw_prompt);
    env->ReleaseStringUTFChars(prompt, raw_prompt);

    std::lock_guard<std::mutex> lock(g_model_mutex);
    if (!g_model || !g_context || !g_sampler) {
        jclass exception = env->FindClass("java/lang/IllegalStateException");
        env->ThrowNew(exception, "Load a GGUF model before generating text.");
        return nullptr;
    }

    const llama_vocab * vocab = llama_model_get_vocab(g_model);
    std::vector<llama_token> tokens(std::max<size_t>(prompt_text.size() + 16, 256));
    int32_t token_count = llama_tokenize(vocab, prompt_text.c_str(), static_cast<int32_t>(prompt_text.size()), tokens.data(), static_cast<int32_t>(tokens.size()), true, true);
    if (token_count < 0) {
        tokens.resize(static_cast<size_t>(-token_count));
        token_count = llama_tokenize(vocab, prompt_text.c_str(), static_cast<int32_t>(prompt_text.size()), tokens.data(), static_cast<int32_t>(tokens.size()), true, true);
    }
    if (token_count <= 0) {
        jclass exception = env->FindClass("java/lang/IllegalArgumentException");
        env->ThrowNew(exception, "Prompt could not be tokenized.");
        return nullptr;
    }
    tokens.resize(static_cast<size_t>(token_count));

    llama_memory_clear(llama_get_memory(g_context), true);
    llama_sampler_reset(g_sampler);
    llama_batch batch = llama_batch_init(512, 0, 1);
    int32_t position = 0;
    for (size_t offset = 0; offset < tokens.size();) {
        const size_t count = std::min<size_t>(batch.n_tokens > 0 ? batch.n_tokens : 512, tokens.size() - offset);
        batch.n_tokens = static_cast<int32_t>(count);
        for (size_t i = 0; i < count; ++i) {
            batch.token[i] = tokens[offset + i];
            batch.pos[i] = position++;
            batch.n_seq_id[i] = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i] = (offset + i + 1 == tokens.size());
        }
        if (llama_decode(g_context, batch) != 0) {
            llama_batch_free(batch);
            jclass exception = env->FindClass("java/lang/IllegalStateException");
            env->ThrowNew(exception, "llama.cpp failed to evaluate the prompt. Reduce context size or use a smaller model.");
            return nullptr;
        }
        offset += count;
    }

    jclass callback_class = env->GetObjectClass(callback);
    jmethodID token_method = env->GetMethodID(callback_class, "onToken", "(Ljava/lang/String;)V");
    jmethodID cancelled_method = env->GetMethodID(callback_class, "isCancelled", "()Z");
    std::string output;
    char piece[256];
    const int limit = std::clamp(max_tokens, 1, 4096);
    for (int generated = 0; generated < limit; ++generated) {
        if (env->CallBooleanMethod(callback, cancelled_method) == JNI_TRUE) break;
        const llama_token token = llama_sampler_sample(g_sampler, g_context, -1);
        if (llama_vocab_is_eog(vocab, token)) break;
        llama_sampler_accept(g_sampler, token);
        const int piece_size = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, true);
        if (piece_size > 0) {
            std::string part(piece, static_cast<size_t>(piece_size));
            output += part;
            jstring chunk = env->NewStringUTF(part.c_str());
            if (chunk) {
                env->CallVoidMethod(callback, token_method, chunk);
                env->DeleteLocalRef(chunk);
            }
        }
        batch.n_tokens = 1;
        batch.token[0] = token;
        batch.pos[0] = position++;
        batch.n_seq_id[0] = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0] = true;
        if (llama_decode(g_context, batch) != 0) break;
    }
    llama_batch_free(batch);
    return env->NewStringUTF(output.c_str());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_isVulkanAvailable(JNIEnv *, jobject) {
    void * handle = dlopen("libvulkan.so", RTLD_NOW | RTLD_LOCAL);
    if (!handle) return JNI_FALSE;
    dlclose(handle);
    return JNI_TRUE;
}
