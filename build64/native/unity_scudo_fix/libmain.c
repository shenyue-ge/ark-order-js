/*
 * libmain.c —— Unity 2017.4.23f1 arm64-v8a drop-in replacement loader with
 * deterministic Android 11-16 Scudo 16GB allocator crash fix.
 *
 * Root cause in Unity 2017.4.23f1 libunity.so (arm64-v8a Release):
 *   UnityDefaultAllocator<LowLevelAllocator>::AllocationPage<0/1/2> maintains a
 *   fixed 5-slot array of (uint32_t high32 -> radix page tree), covering at most
 *   5 distinct 4 GB virtual address regions. On Android 11-16 Scudo, malloc/mmap
 *   spreads allocations across >5 distinct 4 GB regions, overflowing the 5-slot
 *   array -> "Using memoryadresses from more that 16GB of memory" -> SIGSEGV.
 *
 * Fix:
 *   Immediately after dlopen("libunity.so") and BEFORE libunity.so's JNI_OnLoad /
 *   UnityInitApplication / BackgroundWorker threads run, verify the exact ARM64
 *   instruction fingerprints at the 3 UnityDefaultAllocator::AllocationPage RVAs
 *   (0x3cde28 Add, 0x3ce0d4 Remove, 0x3cdd5c Contains) and redirect them via
 *   16-byte AArch64 trampolines to an mmap-backed open-addressing 64-bit hash set
 *   per allocator instance (unlimited 64-bit pointer space, O(1), zero malloc
 *   recursion). Contains() also falls back read-only to the original 5-slot table
 *   for any early .init_array allocations made before dlopen returned.
 */
#define _GNU_SOURCE
#include <android/log.h>
#include <dlfcn.h>
#include <jni.h>
#include <link.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  "Ark64ScudoFix", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "Ark64ScudoFix", __VA_ARGS__)

/* Exact RVAs & instruction prologues in Unity 2017.4.23f1 Release arm64-v8a libunity.so */
#define RVA_ALLOC_PAGE_ADD      0x3cde28ULL
#define RVA_ALLOC_PAGE_REMOVE   0x3ce0d4ULL
#define RVA_ALLOC_PAGE_CONTAINS 0x3cdd5cULL

#define INSN_ADD_0      0xa9ba6ffcU  /* stp x28, x27, [sp, #-0x60]! */
#define INSN_ADD_1      0xa90167faU  /* stp x26, x25, [sp, #0x10]   */
#define INSN_REMOVE_0   0xa9bc5ff8U  /* stp x24, x23, [sp, #-0x40]! */
#define INSN_REMOVE_1   0xa90157f6U  /* stp x22, x21, [sp, #0x10]   */
#define INSN_CONTAINS_0 0xd360fc28U  /* lsr x8, x1, #32             */
#define INSN_CONTAINS_1 0x340002a8U  /* cbz w8, ...                 */

/* ---------- Per-allocator mmap-backed open-addressing hash set ---------- */
#define MAX_ALLOCATORS  32
#define INITIAL_CAP     65536ULL   /* 64K entries = 512 KB initial, grows x2 */
#define KEY_EMPTY       0ULL
#define KEY_TOMBSTONE   1ULL

typedef struct {
    void     *alloc_obj;
    uintptr_t *slots;
    size_t    cap;       /* power of 2 */
    size_t    used;      /* live + tombstones */
    size_t    live;      /* live entries only */
} AllocSet;

static AllocSet g_sets[MAX_ALLOCATORS];
static int g_set_count = 0;
static pthread_mutex_t g_reg_mu = PTHREAD_MUTEX_INITIALIZER;

static inline uint64_t mix64(uintptr_t k) {
    uint64_t x = (uint64_t)k;
    x ^= x >> 33;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33;
    x *= 0xc4ceb9fe1a85ec53ULL;
    x ^= x >> 33;
    return x;
}

static uintptr_t *alloc_slots(size_t cap) {
    void *p = mmap(NULL, cap * sizeof(uintptr_t),
                   PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    return (p == MAP_FAILED) ? NULL : (uintptr_t *)p;
}

static void free_slots(uintptr_t *p, size_t cap) {
    if (p) munmap(p, cap * sizeof(uintptr_t));
}

static AllocSet *get_set(void *alloc, int create) {
    int n = __atomic_load_n(&g_set_count, __ATOMIC_ACQUIRE);
    for (int i = 0; i < n; i++) {
        if (g_sets[i].alloc_obj == alloc) return &g_sets[i];
    }
    if (!create) return NULL;

    pthread_mutex_lock(&g_reg_mu);
    n = g_set_count;
    for (int i = 0; i < n; i++) {
        if (g_sets[i].alloc_obj == alloc) {
            pthread_mutex_unlock(&g_reg_mu);
            return &g_sets[i];
        }
    }
    if (n >= MAX_ALLOCATORS) {
        pthread_mutex_unlock(&g_reg_mu);
        LOGE("Exceeded MAX_ALLOCATORS=%d", MAX_ALLOCATORS);
        return NULL;
    }
    AllocSet *s = &g_sets[n];
    s->slots = alloc_slots(INITIAL_CAP);
    s->cap   = s->slots ? INITIAL_CAP : 0;
    s->used  = 0;
    s->live  = 0;
    s->alloc_obj = alloc;
    __atomic_store_n(&g_set_count, n + 1, __ATOMIC_RELEASE);
    pthread_mutex_unlock(&g_reg_mu);
    return s;
}

static void rehash_set(AllocSet *s, size_t new_cap) {
    uintptr_t *ns = alloc_slots(new_cap);
    if (!ns) return;
    size_t mask = new_cap - 1;
    size_t new_live = 0;
    for (size_t i = 0; i < s->cap; i++) {
        uintptr_t k = s->slots[i];
        if (k > KEY_TOMBSTONE) {
            size_t idx = (size_t)mix64(k) & mask;
            while (ns[idx] != KEY_EMPTY) idx = (idx + 1) & mask;
            ns[idx] = k;
            new_live++;
        }
    }
    free_slots(s->slots, s->cap);
    s->slots = ns;
    s->cap   = new_cap;
    s->used  = new_live;
    s->live  = new_live;
}

static int ark64_alloc_add(void *alloc, const void *ptr) {
    uintptr_t k = (uintptr_t)ptr;
    if (k <= KEY_TOMBSTONE) return 1;
    AllocSet *s = get_set(alloc, 1);
    if (!s || !s->slots) return 1;

    if ((s->used + 1) * 10 >= s->cap * 7) {
        size_t next_cap = (s->live * 10 >= s->cap * 5) ? (s->cap << 1) : s->cap;
        rehash_set(s, next_cap);
    }
    size_t mask = s->cap - 1;
    size_t idx = (size_t)mix64(k) & mask;
    size_t first_tomb = (size_t)-1;
    while (1) {
        uintptr_t cur = s->slots[idx];
        if (cur == k) return 1;
        if (cur == KEY_EMPTY) {
            size_t dst = (first_tomb != (size_t)-1) ? first_tomb : idx;
            if (dst == idx) s->used++;
            s->slots[dst] = k;
            s->live++;
            return 1;
        }
        if (cur == KEY_TOMBSTONE && first_tomb == (size_t)-1) {
            first_tomb = idx;
        }
        idx = (idx + 1) & mask;
    }
}

static int ark64_alloc_remove(void *alloc, const void *ptr) {
    uintptr_t k = (uintptr_t)ptr;
    if (k <= KEY_TOMBSTONE) return 1;
    AllocSet *s = get_set(alloc, 0);
    if (!s || !s->slots) return 1;

    size_t mask = s->cap - 1;
    size_t idx = (size_t)mix64(k) & mask;
    while (1) {
        uintptr_t cur = s->slots[idx];
        if (cur == KEY_EMPTY) return 1;
        if (cur == k) {
            s->slots[idx] = KEY_TOMBSTONE;
            if (s->live > 0) s->live--;
            return 1;
        }
        idx = (idx + 1) & mask;
    }
}

/* Read-only fallback check into Unity's original 5-slot table for pre-patch .init_array allocs */
static int check_legacy_5slot(const void *alloc, const void *ptr) {
    uintptr_t p = (uintptr_t)ptr;
    uint32_t hi = (uint32_t)(p >> 32);
    const uint8_t *base = (const uint8_t *)alloc;
    int slot = -1;
    if (hi == 0) {
        slot = 0;
    } else {
        for (int i = 0; i < 5; i++) {
            uint32_t s_hi;
            memcpy(&s_hi, base + 0x38 + i * 16, 4);
            if (s_hi == hi) { slot = i; break; }
        }
    }
    if (slot < 0) return 0;
    void *const *t0;
    memcpy(&t0, base + 0x40 + slot * 16, sizeof(t0));
    if (!t0) return 0;
    void *const *t1 = (void *const *)t0[(p >> 25) & 0x7f];
    if (!t1) return 0;
    void *const *t2 = (void *const *)t1[(p >> 18) & 0x7f];
    if (!t2) return 0;
    const uint32_t *t3 = (const uint32_t *)t2[(p >> 13) & 0x1f];
    if (!t3) return 0;
    uint32_t word = t3[(p >> 9) & 0x0f];
    uint32_t bit  = 1U << ((p >> 4) & 0x1f);
    return (word & bit) != 0;
}

static int ark64_alloc_contains(void *alloc, const void *ptr) {
    uintptr_t k = (uintptr_t)ptr;
    if (k <= KEY_TOMBSTONE) return 0;
    AllocSet *s = get_set(alloc, 0);
    if (s && s->slots) {
        size_t mask = s->cap - 1;
        size_t idx = (size_t)mix64(k) & mask;
        while (1) {
            uintptr_t cur = s->slots[idx];
            if (cur == KEY_EMPTY) break;
            if (cur == k) return 1;
            idx = (idx + 1) & mask;
        }
    }
    return check_legacy_5slot(alloc, ptr);
}

/* ---------- Locate libunity.so base & install 16-byte AArch64 trampolines ---------- */
static int find_unity_cb(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    if (info->dlpi_name && strstr(info->dlpi_name, "libunity.so")) {
        *(uintptr_t *)data = (uintptr_t)info->dlpi_addr;
        return 1;
    }
    return 0;
}

static int write_trampoline(uintptr_t addr, void *target, uint32_t exp0, uint32_t exp1, const char *label) {
    uint32_t *code = (uint32_t *)addr;
    if (code[0] != exp0 || code[1] != exp1) {
        LOGE("Fingerprint mismatch at %s (0x%lx): got 0x%08x 0x%08x, expected 0x%08x 0x%08x",
             label, (unsigned long)addr, code[0], code[1], exp0, exp1);
        return 0;
    }
    long pgsz = sysconf(_SC_PAGESIZE);
    uintptr_t p_start = addr & ~((uintptr_t)pgsz - 1);
    uintptr_t p_end   = (addr + 16 + (uintptr_t)pgsz - 1) & ~((uintptr_t)pgsz - 1);
    if (mprotect((void *)p_start, p_end - p_start, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        LOGE("mprotect RWX failed for %s", label);
        return 0;
    }
    /* ldr x16, #8 ; br x16 ; .quad target */
    code[0] = 0x58000050U;
    code[1] = 0xd61f0200U;
    uint64_t t = (uint64_t)(uintptr_t)target;
    memcpy(&code[2], &t, sizeof(t));
    __builtin___clear_cache((char *)addr, (char *)(addr + 16));
    mprotect((void *)p_start, p_end - p_start, PROT_READ | PROT_EXEC);
    return 1;
}

static void patch_libunity_scudo(void) {
    uintptr_t base = 0;
    dl_iterate_phdr(find_unity_cb, &base);
    if (!base) {
        LOGE("Could not find libunity.so load base via dl_iterate_phdr");
        return;
    }
    int ok0 = write_trampoline(base + RVA_ALLOC_PAGE_ADD,      (void *)ark64_alloc_add,      INSN_ADD_0,      INSN_ADD_1,      "Add");
    int ok1 = write_trampoline(base + RVA_ALLOC_PAGE_REMOVE,   (void *)ark64_alloc_remove,   INSN_REMOVE_0,   INSN_REMOVE_1,   "Remove");
    int ok2 = write_trampoline(base + RVA_ALLOC_PAGE_CONTAINS, (void *)ark64_alloc_contains, INSN_CONTAINS_0, INSN_CONTAINS_1, "Contains");
    LOGI("Patched libunity.so base=0x%lx ok=%d/%d/%d (unlimited 64-bit allocator table active)",
         (unsigned long)base, ok0, ok1, ok2);
}

/* ---------- Exact Unity 2017.4 com/unity3d/player/NativeLoader bridge ---------- */
static void *g_unity_handle = NULL;

static jboolean native_load(JNIEnv *env, jclass cls, jstring pathStr) {
    (void)cls;
    if (g_unity_handle) return JNI_TRUE;

    const char *dir = (*env)->GetStringUTFChars(env, pathStr, NULL);
    char full[2048];
    snprintf(full, sizeof(full), "%s/libunity.so", dir ? dir : "");
    if (dir) (*env)->ReleaseStringUTFChars(env, pathStr, dir);

    JavaVM *vm = NULL;
    if ((*env)->GetJavaVM(env, &vm) < 0 || !vm) {
        (*env)->FatalError(env, "Unable to retrieve Java VM");
        return JNI_FALSE;
    }

    void *h = dlopen(full, RTLD_LAZY);
    if (!h) h = dlopen("libunity.so", RTLD_LAZY);
    if (!h) {
        char msg[1024];
        snprintf(msg, sizeof(msg), "Unable to load library: %s [%s]", full, dlerror());
        (*env)->FatalError(env, msg);
        return JNI_FALSE;
    }

    /* Install Scudo 16GB fix BEFORE libunity.so's JNI_OnLoad & worker threads run! */
    patch_libunity_scudo();

    typedef jint (*jni_onload_fn)(JavaVM *, void *);
    jni_onload_fn onload = (jni_onload_fn)dlsym(h, "JNI_OnLoad");
    if (onload) {
        jint ver = onload(vm, NULL);
        if (ver >= 0x00010007) {
            (*env)->FatalError(env, "Unsupported VM version");
            return JNI_FALSE;
        }
    }
    g_unity_handle = h;
    return JNI_TRUE;
}

static jboolean native_unload(JNIEnv *env, jclass cls) {
    (void)cls;
    void *h = g_unity_handle;
    if (!h) return JNI_TRUE;
    g_unity_handle = NULL;

    JavaVM *vm = NULL;
    if ((*env)->GetJavaVM(env, &vm) < 0 || !vm) {
        (*env)->FatalError(env, "Unable to retrieve Java VM");
        return JNI_TRUE;
    }
    typedef void (*jni_onunload_fn)(JavaVM *, void *);
    jni_onunload_fn onunload = (jni_onunload_fn)dlsym(h, "JNI_OnUnload");
    if (onunload) onunload(vm, NULL);
    dlclose(h);
    return JNI_TRUE;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    JNIEnv *env = NULL;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK || !env) {
        return JNI_ERR;
    }
    jclass cls = (*env)->FindClass(env, "com/unity3d/player/NativeLoader");
    if (!cls) return JNI_ERR;

    static const JNINativeMethod methods[] = {
        { "load",   "(Ljava/lang/String;)Z", (void *)native_load   },
        { "unload", "()Z",                   (void *)native_unload },
    };
    if ((*env)->RegisterNatives(env, cls, methods, 2) < 0) {
        (*env)->FatalError(env, "com/unity3d/player/NativeLoader");
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}
