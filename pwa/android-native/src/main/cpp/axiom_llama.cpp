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
#include <vulkan/vulkan.h>

#define AXIOM_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "AxiomLLM", __VA_ARGS__)

static size_t valid_utf8_prefix(const std::string & value) {
    size_t i = 0;
    while (i < value.size()) {
        const unsigned char lead = static_cast<unsigned char>(value[i]);
        size_t count = 0;
        if (lead <= 0x7f) count = 1;
        else if (lead >= 0xc2 && lead <= 0xdf) count = 2;
        else if (lead >= 0xe0 && lead <= 0xef) count = 3;
        else if (lead >= 0xf0 && lead <= 0xf4) count = 4;
        else return i;
        if (i + count > value.size()) return i;
        for (size_t j = 1; j < count; ++j) {
            const unsigned char next = static_cast<unsigned char>(value[i + j]);
            if ((next & 0xc0) != 0x80) return i;
        }
        if (count == 3) {
            const unsigned char second = static_cast<unsigned char>(value[i + 1]);
            if ((lead == 0xe0 && second < 0xa0) || (lead == 0xed && second >= 0xa0)) return i;
        }
        if (count == 4) {
            const unsigned char second = static_cast<unsigned char>(value[i + 1]);
            if ((lead == 0xf0 && second < 0x90) || (lead == 0xf4 && second >= 0x90)) return i;
        }
        i += count;
    }
    return i;
}

static std::string jstring_to_utf8(JNIEnv * env, jstring value) {
    if (!value) return {};
    const jsize length = env->GetStringLength(value);
    const jchar * chars = env->GetStringChars(value, nullptr);
    std::string output;
    output.reserve(static_cast<size_t>(length) * 3);
    for (jsize i = 0; i < length; ++i) {
        uint32_t cp = chars[i];
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < length) {
            const uint32_t low = chars[i + 1];
            if (low >= 0xdc00 && low <= 0xdfff) {
                cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                ++i;
            }
        }
        if (cp <= 0x7f) output.push_back(static_cast<char>(cp));
        else if (cp <= 0x7ff) {
            output.push_back(static_cast<char>(0xc0 | (cp >> 6)));
            output.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        } else if (cp <= 0xffff) {
            output.push_back(static_cast<char>(0xe0 | (cp >> 12)));
            output.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
            output.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        } else {
            output.push_back(static_cast<char>(0xf0 | (cp >> 18)));
            output.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3f)));
            output.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
            output.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        }
    }
    env->ReleaseStringChars(value, chars);
    return output;
}

static jstring utf8_to_jstring(JNIEnv * env, const std::string & value) {
    std::vector<jchar> output;
    output.reserve(value.size());
    for (size_t i = 0; i < value.size();) {
        const unsigned char lead = static_cast<unsigned char>(value[i]);
        uint32_t cp = 0xfffd;
        size_t count = 1;
        if (lead <= 0x7f) cp = lead;
        else if (lead >= 0xc2 && lead <= 0xdf && i + 1 < value.size()) {
            cp = ((lead & 0x1f) << 6) | (static_cast<unsigned char>(value[i + 1]) & 0x3f); count = 2;
        } else if (lead >= 0xe0 && lead <= 0xef && i + 2 < value.size()) {
            cp = ((lead & 0x0f) << 12) | ((static_cast<unsigned char>(value[i + 1]) & 0x3f) << 6) | (static_cast<unsigned char>(value[i + 2]) & 0x3f); count = 3;
        } else if (lead >= 0xf0 && lead <= 0xf4 && i + 3 < value.size()) {
            cp = ((lead & 0x07) << 18) | ((static_cast<unsigned char>(value[i + 1]) & 0x3f) << 12) | ((static_cast<unsigned char>(value[i + 2]) & 0x3f) << 6) | (static_cast<unsigned char>(value[i + 3]) & 0x3f); count = 4;
        }
        if (cp <= 0xffff) output.push_back(static_cast<jchar>(cp));
        else {
            cp -= 0x10000;
            output.push_back(static_cast<jchar>(0xd800 + (cp >> 10)));
            output.push_back(static_cast<jchar>(0xdc00 + (cp & 0x3ff)));
        }
        i += count;
    }
    return env->NewString(output.data(), static_cast<jsize>(output.size()));
}

static std::mutex g_model_mutex;
static llama_model * g_model = nullptr;
static llama_context * g_context = nullptr;
static llama_sampler * g_sampler = nullptr;
static std::string g_loaded_path;
static int g_requested_gpu_layers = 0;

static void release_model_locked() {
    if (g_sampler) { llama_sampler_free(g_sampler); g_sampler = nullptr; }
    if (g_context) { llama_free(g_context); g_context = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_loaded_path.clear();
    g_requested_gpu_layers = 0;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaLoadModel(JNIEnv * env, jobject, jstring path, jint context_size, jint threads, jint gpu_layers) {
    const char * raw_path = env->GetStringUTFChars(path, nullptr);
    if (!raw_path) return JNI_FALSE;
    std::string model_path(raw_path);
    env->ReleaseStringUTFChars(path, raw_path);

    std::lock_guard<std::mutex> lock(g_model_mutex);
    if (g_loaded_path == model_path && g_context) return JNI_TRUE;
    release_model_locked();

    llama_backend_init();
    const int requested_gpu_layers = std::clamp(static_cast<int>(gpu_layers), -1, 999);
    const uint32_t safe_context_size = static_cast<uint32_t>(std::clamp(context_size, 512, 8192));
    const int safe_threads = std::clamp(threads, 1, 16);

    auto load_model_and_context = [&](int gpu_layer_count) -> bool {
        llama_model_params model_params = llama_model_default_params();
        model_params.n_gpu_layers = gpu_layer_count;
        g_model = llama_model_load_from_file(model_path.c_str(), model_params);
        if (!g_model) return false;

        llama_context_params context_params = llama_context_default_params();
        context_params.n_ctx = safe_context_size;
        context_params.n_batch = 512;
        context_params.n_threads = safe_threads;
        context_params.n_threads_batch = safe_threads;
        g_context = llama_init_from_model(g_model, context_params);
        if (!g_context) {
            llama_model_free(g_model);
            g_model = nullptr;
            return false;
        }
        return true;
    };

    int active_gpu_layers = requested_gpu_layers;
    if (!load_model_and_context(requested_gpu_layers)) {
        if (requested_gpu_layers != 0) {
            AXIOM_LOGE("GPU model/context initialization failed; retrying with CPU-only inference");
            release_model_locked();
            active_gpu_layers = 0;
            if (!load_model_and_context(0)) {
                AXIOM_LOGE("CPU fallback also failed for GGUF model: %s", model_path.c_str());
                release_model_locked();
                return JNI_FALSE;
            }
        } else {
            AXIOM_LOGE("Failed to load GGUF model or create its context: %s", model_path.c_str());
            release_model_locked();
            return JNI_FALSE;
        }
    }

    llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
    g_sampler = llama_sampler_chain_init(sampler_params);
    llama_sampler_chain_add(g_sampler, llama_sampler_init_temp(0.7f));
    llama_sampler_chain_add(g_sampler, llama_sampler_init_dist(0xA710ULL));
    g_loaded_path = model_path;
    g_requested_gpu_layers = active_gpu_layers;
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

extern "C" JNIEXPORT jint JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaLoadedGpuLayers(JNIEnv *, jobject) {
    std::lock_guard<std::mutex> lock(g_model_mutex);
    return g_requested_gpu_layers;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_llamaGenerate(JNIEnv * env, jobject, jobjectArray roles, jobjectArray contents, jint max_tokens, jobject callback) {
    const jsize message_count = env->GetArrayLength(roles);
    if (message_count <= 0 || message_count != env->GetArrayLength(contents)) {
        jclass exception = env->FindClass("java/lang/IllegalArgumentException");
        env->ThrowNew(exception, "At least one role/content message is required.");
        return nullptr;
    }

    std::vector<std::string> role_values;
    std::vector<std::string> content_values;
    std::vector<llama_chat_message> chat;
    size_t prompt_capacity = 1024;
    for (jsize i = 0; i < message_count; ++i) {
        auto role = static_cast<jstring>(env->GetObjectArrayElement(roles, i));
        auto content = static_cast<jstring>(env->GetObjectArrayElement(contents, i));
        role_values.emplace_back(jstring_to_utf8(env, role));
        content_values.emplace_back(jstring_to_utf8(env, content));
        if (role_values.back().empty()) role_values.back() = "user";
        env->DeleteLocalRef(role);
        env->DeleteLocalRef(content);
        prompt_capacity += (role_values.back().size() + content_values.back().size()) * 2 + 64;
    }

    std::lock_guard<std::mutex> lock(g_model_mutex);
    if (!g_model || !g_context || !g_sampler) {
        jclass exception = env->FindClass("java/lang/IllegalStateException");
        env->ThrowNew(exception, "Load a GGUF model before generating text.");
        return nullptr;
    }

    for (size_t i = 0; i < role_values.size(); ++i) {
        chat.push_back({ role_values[i].c_str(), content_values[i].c_str() });
    }
    const char * template_source = llama_model_chat_template(g_model, nullptr);
    std::vector<char> formatted(prompt_capacity);
    int32_t formatted_size = template_source
        ? llama_chat_apply_template(template_source, chat.data(), chat.size(), true, formatted.data(), static_cast<int32_t>(formatted.size()))
        : -1;
    std::string prompt_text;
    if (formatted_size >= 0) {
        if (static_cast<size_t>(formatted_size) > formatted.size()) {
            formatted.resize(static_cast<size_t>(formatted_size) + 1);
            formatted_size = llama_chat_apply_template(template_source, chat.data(), chat.size(), true, formatted.data(), static_cast<int32_t>(formatted.size()));
        }
        if (formatted_size < 0 || static_cast<size_t>(formatted_size) > formatted.size()) {
            jclass exception = env->FindClass("java/lang/IllegalStateException");
            env->ThrowNew(exception, "The model chat template could not format this conversation.");
            return nullptr;
        }
        prompt_text.assign(formatted.data(), static_cast<size_t>(formatted_size));
    } else {
        for (size_t i = 0; i < role_values.size(); ++i) {
            prompt_text += role_values[i] + ":\n" + content_values[i] + "\n\n";
        }
        prompt_text += "assistant:\n";
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
        env->ThrowNew(exception, "Conversation could not be tokenized.");
        return nullptr;
    }
    tokens.resize(static_cast<size_t>(token_count));
    const uint32_t context_limit = llama_n_ctx(g_context);
    const int generation_limit = std::clamp(max_tokens, 1, 4096);
    const size_t prompt_limit = context_limit > static_cast<uint32_t>(generation_limit)
        ? context_limit - static_cast<uint32_t>(generation_limit) : context_limit - 1;
    if (tokens.size() > prompt_limit) {
        tokens.erase(tokens.begin(), tokens.end() - static_cast<ptrdiff_t>(prompt_limit));
    }

    llama_memory_clear(llama_get_memory(g_context), true);
    llama_sampler_reset(g_sampler);
    llama_batch batch = llama_batch_init(512, 0, 1);
    int32_t position = 0;
    for (size_t offset = 0; offset < tokens.size();) {
        const size_t count = std::min<size_t>(512, tokens.size() - offset);
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
    size_t emitted_bytes = 0;
    char piece[256];
    for (int generated = 0; generated < generation_limit; ++generated) {
        if (env->CallBooleanMethod(callback, cancelled_method) == JNI_TRUE) break;
        const llama_token token = llama_sampler_sample(g_sampler, g_context, -1);
        if (llama_vocab_is_eog(vocab, token)) break;
        llama_sampler_accept(g_sampler, token);
        const int piece_size = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, true);
        if (piece_size > 0) {
            std::string part(piece, static_cast<size_t>(piece_size));
            output += part;
            const size_t safe_bytes = valid_utf8_prefix(output);
            if (safe_bytes > emitted_bytes) {
                const std::string safe_chunk = output.substr(emitted_bytes, safe_bytes - emitted_bytes);
                jstring chunk = utf8_to_jstring(env, safe_chunk);
                if (chunk) {
                    env->CallVoidMethod(callback, token_method, chunk);
                    env->DeleteLocalRef(chunk);
                }
                emitted_bytes = safe_bytes;
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
    output.resize(valid_utf8_prefix(output));
    return utf8_to_jstring(env, output);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_gpuOffloadSupported(JNIEnv *, jobject) {
    return llama_supports_gpu_offload() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_isVulkanAvailable(JNIEnv *, jobject) {
    void * handle = dlopen("libvulkan.so", RTLD_NOW | RTLD_LOCAL);
    if (!handle) return JNI_FALSE;
    dlclose(handle);
    return JNI_TRUE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_axiom_mobile_AxiomModelsPlugin_vulkanDeviceName(JNIEnv * env, jobject) {
    VkApplicationInfo app_info{};
    app_info.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    app_info.pApplicationName = "Axiom";
    app_info.apiVersion = VK_API_VERSION_1_0;
    VkInstanceCreateInfo create_info{};
    create_info.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    create_info.pApplicationInfo = &app_info;
    VkInstance instance = VK_NULL_HANDLE;
    if (vkCreateInstance(&create_info, nullptr, &instance) != VK_SUCCESS) return env->NewStringUTF("");
    uint32_t count = 0;
    if (vkEnumeratePhysicalDevices(instance, &count, nullptr) != VK_SUCCESS || count == 0) {
        vkDestroyInstance(instance, nullptr);
        return env->NewStringUTF("");
    }
    std::vector<VkPhysicalDevice> devices(count);
    if (vkEnumeratePhysicalDevices(instance, &count, devices.data()) != VK_SUCCESS) {
        vkDestroyInstance(instance, nullptr);
        return env->NewStringUTF("");
    }
    std::string name;
    for (const VkPhysicalDevice device : devices) {
        uint32_t queue_count = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(device, &queue_count, nullptr);
        std::vector<VkQueueFamilyProperties> queues(queue_count);
        vkGetPhysicalDeviceQueueFamilyProperties(device, &queue_count, queues.data());
        const bool has_compute = std::any_of(queues.begin(), queues.end(), [](const VkQueueFamilyProperties & queue) {
            return (queue.queueFlags & VK_QUEUE_COMPUTE_BIT) != 0 && queue.queueCount > 0;
        });
        if (!has_compute) continue;
        VkPhysicalDeviceProperties properties{};
        vkGetPhysicalDeviceProperties(device, &properties);
        name = properties.deviceName;
        break;
    }
    vkDestroyInstance(instance, nullptr);
    return utf8_to_jstring(env, name);
}
