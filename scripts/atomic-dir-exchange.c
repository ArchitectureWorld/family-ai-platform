#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

static int valid_dir(const char *path) {
  struct stat value;
  return path && path[0] == '/' && lstat(path, &value) == 0 &&
         S_ISDIR(value.st_mode) && !S_ISLNK(value.st_mode);
}

int main(int argc, char **argv) {
  if (argc != 3 || !valid_dir(argv[1]) || !valid_dir(argv[2]) ||
      strcmp(argv[1], argv[2]) == 0) {
    fputs("ATOMIC_DIR_EXCHANGE_INVALID_ARGUMENTS\n", stderr);
    return 2;
  }
  if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2],
              RENAME_EXCHANGE) != 0) {
    fprintf(stderr, "ATOMIC_DIR_EXCHANGE_FAILED:%s\n", strerror(errno));
    return 1;
  }
  return 0;
}
