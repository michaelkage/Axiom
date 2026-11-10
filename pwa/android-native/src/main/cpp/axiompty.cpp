#include <jni.h>
#include <pty.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>
#include <cstdlib>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <mutex>

struct PtySession { int fd; pid_t pid; };
static std::unordered_map<jlong, PtySession> sessions;
static std::mutex sessionsMutex;
static jlong makeHandle(int fd, pid_t pid) { return static_cast<jlong>((static_cast<uint64_t>(pid) << 32) | static_cast<uint32_t>(fd)); }
static PtySession lookup(jlong handle) {
    std::lock_guard<std::mutex> lock(sessionsMutex);
    auto it = sessions.find(handle);
    return it == sessions.end() ? PtySession{-1, -1} : it->second;
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_axiom_mobile_AxiomRuntimePlugin_nativeStart(JNIEnv* env, jobject, jstring cwd, jint rows, jint cols) {
    const char* path = env->GetStringUTFChars(cwd, nullptr);
    struct winsize size{};
    size.ws_row = static_cast<unsigned short>(rows);
    size.ws_col = static_cast<unsigned short>(cols);
    int master = -1;
    pid_t pid = forkpty(&master, nullptr, nullptr, &size);
    if (pid == 0) {
        setenv("TERM", "xterm-256color", 1);
        setenv("HOME", path, 1);
        setenv("PWD", path, 1);
        setenv("PATH", "/system/bin:/system/xbin", 1);
        chdir(path);
        execl("/system/bin/sh", "sh", "-i", static_cast<char*>(nullptr));
        _exit(127);
    }
    env->ReleaseStringUTFChars(cwd, path);
    if (pid < 0 || master < 0) return 0;
    const jlong handle = makeHandle(master, pid);
    {
        std::lock_guard<std::mutex> lock(sessionsMutex);
        sessions.emplace(handle, PtySession{master, pid});
    }
    return handle;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_axiom_mobile_AxiomRuntimePlugin_nativeRead(JNIEnv* env, jobject, jlong handle, jbyteArray output, jint offset, jint length) {
    const auto session = lookup(handle);
    if (session.fd < 0) return -1;
    jbyte* bytes = env->GetByteArrayElements(output, nullptr);
    const ssize_t count = read(session.fd, bytes + offset, static_cast<size_t>(length));
    env->ReleaseByteArrayElements(output, bytes, count > 0 ? 0 : JNI_ABORT);
    return static_cast<jint>(count);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_axiom_mobile_AxiomRuntimePlugin_nativeWrite(JNIEnv* env, jobject, jlong handle, jbyteArray input) {
    const auto session = lookup(handle);
    if (session.fd < 0) return -1;
    const jsize length = env->GetArrayLength(input);
    jbyte* bytes = env->GetByteArrayElements(input, nullptr);
    const ssize_t count = write(session.fd, bytes, static_cast<size_t>(length));
    env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
    return static_cast<jint>(count);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomRuntimePlugin_nativeResize(JNIEnv*, jobject, jlong handle, jint rows, jint cols) {
    const auto session = lookup(handle);
    if (session.fd < 0) return JNI_FALSE;
    struct winsize size{};
    size.ws_row = static_cast<unsigned short>(rows);
    size.ws_col = static_cast<unsigned short>(cols);
    return ioctl(session.fd, TIOCSWINSZ, &size) == 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_axiom_mobile_AxiomRuntimePlugin_nativeClose(JNIEnv*, jobject, jlong handle, jint signalNumber) {
    PtySession session;
    {
        std::lock_guard<std::mutex> lock(sessionsMutex);
        auto it = sessions.find(handle);
        if (it == sessions.end()) return JNI_TRUE;
        session = it->second;
        sessions.erase(it);
    }
    if (session.pid > 0) kill(-session.pid, signalNumber);
    if (session.fd >= 0) close(session.fd);
    if (session.pid > 0) {
        int status = 0;
        pid_t result = 0;
        for (int attempt = 0; attempt < 100; ++attempt) {
            result = waitpid(session.pid, &status, WNOHANG);
            if (result == session.pid || (result < 0 && errno != EINTR)) break;
            usleep(10000);
        }
        if (result == 0 || (result < 0 && errno == EINTR)) {
            kill(-session.pid, SIGKILL);
            while (waitpid(session.pid, &status, 0) < 0 && errno == EINTR) {}
        }
    }
    return JNI_TRUE;
}
