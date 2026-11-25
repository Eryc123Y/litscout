/* Read a local workerd process's cumulative user + system CPU in nanoseconds. */
#include <stdio.h>
#include <stdlib.h>

#ifdef __APPLE__
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdint.h>

static long long cpu_ns(int pid) {
  struct rusage_info_v2 usage;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage) != 0)
    return -1;
  mach_timebase_info_data_t scale;
  if (mach_timebase_info(&scale) != KERN_SUCCESS)
    return -1;
  return (long long)((long double)(usage.ri_user_time + usage.ri_system_time) *
                     scale.numer / scale.denom);
}
#elif defined(__linux__)
#include <time.h>

static long long cpu_ns(int pid) {
  clockid_t clock;
  struct timespec usage;
  if (clock_getcpuclockid(pid, &clock) != 0 || clock_gettime(clock, &usage) != 0)
    return -1;
  return usage.tv_sec * 1000000000LL + usage.tv_nsec;
}
#else
#error This benchmark supports macOS and Linux.
#endif

int main(int argc, char **argv) {
  if (argc != 2)
    return 1;
  long long time = cpu_ns(atoi(argv[1]));
  if (time < 0)
    return 1;
  printf("%lld\n", time);
  return 0;
}
