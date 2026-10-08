// Author: suwubee
// LD_PRELOAD shim for Chromium/SwiftShader CPU pinning (built on demand by tools/cinematic/lib/browser.mjs, launchBrowser({nproc})).
//
// Problem 1: SwiftShader's marl scheduler sizes its worker pool from sysconf(_SC_NPROCESSORS_ONLN) (= 16 here),
//            ignoring the taskset mask.            -> sysconf/get_nprocs report $MV_NPROC.
// Problem 2: marl then pins its workers with pthread_setaffinity_np() to CPU *indices* 0..count-1 of the allowed
//            mask (not the real CPU ids), so a Chromium started under `taskset -c 6,7,14,15` actually runs its
//            SwiftShader workers on CPUs 0-3, and all pinned Chromiums on the machine pile up on the lowest CPUs.
//            -> pthread_setaffinity_np / sched_setaffinity become no-ops (threads keep the inherited taskset mask)
//               unless MV_ALLOW_AFFINITY=1.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <sched.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/sysinfo.h>

static int forced(void) {
  const char *e = getenv("MV_NPROC");
  return e ? atoi(e) : 0;
}
static int allow_affinity(void) {
  const char *e = getenv("MV_ALLOW_AFFINITY");
  return e && *e == '1';
}

long sysconf(int name) {
  static long (*real)(int) = 0;
  if (!real) real = (long (*)(int))dlsym(RTLD_NEXT, "sysconf");
  int n = forced();
  if (n > 0 && (name == _SC_NPROCESSORS_ONLN || name == _SC_NPROCESSORS_CONF)) return n;
  return real(name);
}

int get_nprocs(void) {
  static int (*real)(void) = 0;
  if (!real) real = (int (*)(void))dlsym(RTLD_NEXT, "get_nprocs");
  int n = forced();
  return n > 0 ? n : real();
}

int get_nprocs_conf(void) {
  static int (*real)(void) = 0;
  if (!real) real = (int (*)(void))dlsym(RTLD_NEXT, "get_nprocs_conf");
  int n = forced();
  return n > 0 ? n : real();
}

int pthread_setaffinity_np(pthread_t thread, size_t size, const cpu_set_t *set) {
  static int (*real)(pthread_t, size_t, const cpu_set_t *) = 0;
  if (allow_affinity()) {
    if (!real) real = (int (*)(pthread_t, size_t, const cpu_set_t *))dlsym(RTLD_NEXT, "pthread_setaffinity_np");
    return real(thread, size, set);
  }
  return 0;
}

int sched_setaffinity(pid_t pid, size_t size, const cpu_set_t *set) {
  static int (*real)(pid_t, size_t, const cpu_set_t *) = 0;
  if (allow_affinity()) {
    if (!real) real = (int (*)(pid_t, size_t, const cpu_set_t *))dlsym(RTLD_NEXT, "sched_setaffinity");
    return real(pid, size, set);
  }
  return 0;
}
