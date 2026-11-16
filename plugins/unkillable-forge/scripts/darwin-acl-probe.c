#define _DARWIN_C_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

/* Temporary CI diagnostic: use only on freshly-created synthetic fixtures. */
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { printf("open errno=%d\n", errno); return 1; }
  struct stat st;
  errno = 0; int sr = fstat(fd, &st), se = errno;
  if (sr == 0) printf("fstat rc=%d errno=%d uid=%lu mode=%04o nlink=%lu\n", sr, se, (unsigned long)st.st_uid, (unsigned)(st.st_mode & 07777), (unsigned long)st.st_nlink);
  else printf("fstat rc=%d errno=%d\n", sr, se);
  errno = 0; long support = fpathconf(fd, _PC_EXTENDED_SECURITY_NP); int pe = errno;
  printf("fpathconf result=%ld errno=%d\n", support, pe);
  filesec_t sec = filesec_init();
  if (!sec) { printf("filesec_init errno=%d\n", errno); close(fd); return 1; }
  errno = 0; int xr = fstatx_np(fd, &st, sec), xe = errno;
  printf("fstatx rc=%d errno=%d\n", xr, xe);
  int uuid = -1, acl = -1;
  errno = 0; int ur = filesec_query_property(sec, FILESEC_UUID, &uuid), ue = errno;
  errno = 0; int ar = filesec_query_property(sec, FILESEC_ACL, &acl), ae = errno;
  printf("uuid query=%d errno=%d valid=%d; acl query=%d errno=%d valid=%d\n", ur, ue, uuid, ar, ae, acl);
  filesec_free(sec);
  errno = 0; acl_t value = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); int ge = errno;
  printf("acl_get present=%d errno=%d\n", value != NULL, ge);
  if (value) acl_free(value);
  close(fd);
  return 0;
}
