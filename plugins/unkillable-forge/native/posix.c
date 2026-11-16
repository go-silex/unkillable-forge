#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/param.h>
#include <sys/statvfs.h>
#include <sys/file.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/acl.h>
#endif

#ifndef O_CLOEXEC
#error O_CLOEXEC is required
#endif

typedef struct { int fd; } owned_fd;
static void finalize(napi_env env, void *data, void *hint) { (void)env; (void)hint; owned_fd *h = data; if (h->fd >= 0) close(h->fd); free(h); }
static const char *errno_code(int e) {
  switch (e) { case EACCES: return "EACCES"; case EPERM: return "EPERM"; case ENOENT: return "ENOENT"; case EEXIST: return "EEXIST"; case ENOTDIR: return "ENOTDIR"; case ELOOP: return "ELOOP"; case ENOTEMPTY: return "ENOTEMPTY"; case EINVAL: return "EINVAL"; case ENOSPC: return "ENOSPC"; case EAGAIN: return "EAGAIN"; default: return "EIO"; }
}
static napi_value fail(napi_env env, int e) { napi_value msg, err, code; napi_create_string_utf8(env, "filesystem operation failed", NAPI_AUTO_LENGTH, &msg); napi_create_error(env, NULL, msg, &err); napi_create_string_utf8(env, errno_code(e), NAPI_AUTO_LENGTH, &code); napi_set_named_property(env, err, "code", code); napi_throw(env, err); return NULL; }
static napi_value invalid(napi_env env) { napi_throw_type_error(env, NULL, "invalid filesystem argument"); return NULL; }
static int args(napi_env env, napi_callback_info info, size_t n, napi_value *v) { size_t count = n; return napi_get_cb_info(env, info, &count, v, NULL, NULL) == napi_ok && count == n; }
static owned_fd *get(napi_env env, napi_value v) { owned_fd *h = NULL; if (napi_unwrap(env, v, (void **)&h) != napi_ok || !h || h->fd < 0) { napi_throw_error(env, NULL, "filesystem_closed"); return NULL; } return h; }
/* MAXPATHLEN is the native pathname byte capacity, including its terminator.
 * It also accommodates Darwin UTF-8 component names beyond 255 bytes. */
static int text(napi_env env, napi_value v, char s[MAXPATHLEN]) {
  size_t n = 0, actual = 0;
  return napi_get_value_string_utf8(env, v, NULL, 0, &n) == napi_ok &&
    n > 0 && n < MAXPATHLEN &&
    napi_get_value_string_utf8(env, v, s, MAXPATHLEN, &actual) == napi_ok &&
    actual == n && strlen(s) == n;
}
static int component(const char *s) { return s && *s && strcmp(s, ".") && strcmp(s, "..") && !strchr(s, '/'); }
static napi_value handle(napi_env env, int fd) { napi_value obj; owned_fd *h = malloc(sizeof(*h)); if (!h) { close(fd); return fail(env, ENOMEM); } h->fd = fd; if (napi_create_object(env, &obj) != napi_ok || napi_wrap(env, obj, h, finalize, NULL, NULL) != napi_ok) { close(fd); free(h); return fail(env, ENOMEM); } return obj; }
#ifdef __APPLE__
/*
 * Require mount-level extended-security support and a successful fstatx_np.
 * XNU's vnode_getattr resolves a missing requested ACL through its filesec
 * fallback, propagating errors; libc reports absent ACL as an unset property.
 * A missing UUID property is normal for ACL-free APFS objects. Any ACL
 * (including deny-only), unavailable support, or query failure is rejected.
 */
static int private_acl_check(int fd, struct stat *st) {
  if (fpathconf(fd, _PC_EXTENDED_SECURITY_NP) != 1) { errno = EPERM; return -1; }
  filesec_t security = filesec_init();
  if (!security) return -1;
  int has_acl = 0;
  /* Apple's statx_np realloc-failure path can return success with ENOMEM. */
  errno = 0;
  int stat_result = fstatx_np(fd, st, security);
  int stat_error = errno;
  int ok = stat_result == 0 && stat_error != ENOMEM &&
    filesec_query_property(security, FILESEC_ACL, &has_acl) == 0 && !has_acl;
  filesec_free(security);
  if (!ok) { errno = EPERM; return -1; }
  return 0;
}
#endif
static int checked(int fd, int private_kind) {
  struct stat st;
#ifdef __APPLE__
  if (private_kind == 1 || private_kind == 2) {
    if (private_acl_check(fd, &st) < 0) return -1;
  } else
#endif
  if (fstat(fd, &st) < 0) return -1;
  if (private_kind == 1 && (!S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 0777) != 0700)) { errno = EPERM; return -1; }
  if (private_kind == 2 && (!S_ISREG(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077) != 0 || st.st_nlink != 1)) { errno = EPERM; return -1; }
  if (private_kind == 3 && !S_ISREG(st.st_mode)) { errno = EINVAL; return -1; }
  return 0;
}
static int open_retry(const char *p, int f) { int fd; do { fd = open(p, f); } while (fd < 0 && errno == EINTR); return fd; }
static int openat_retry(int d, const char *p, int f, mode_t m) { int fd; do { fd = openat(d, p, f, m); } while (fd < 0 && errno == EINTR); return fd; }
static napi_value root(napi_env e, napi_callback_info i) { (void)i; int fd = open_retry("/", O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); return fd < 0 ? fail(e, errno) : handle(e, fd); }
/* child(handle, name, create, private): creation tolerates only an existing directory. */
static napi_value child(napi_env e, napi_callback_info i) { napi_value v[4]; bool create, priv; if (!args(e,i,4,v)) return invalid(e); owned_fd *h=get(e,v[0]); if (!h) return NULL; char s[MAXPATHLEN]; if (!text(e,v[1],s) || !component(s) || napi_get_value_bool(e,v[2],&create)!=napi_ok || napi_get_value_bool(e,v[3],&priv)!=napi_ok) return invalid(e); if (create && mkdirat(h->fd,s,0700)<0 && errno!=EEXIST) return fail(e,errno); int fd=openat_retry(h->fd,s,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC,0); if(fd<0) return fail(e,errno); if (priv && checked(fd,1)<0) { int x=errno; close(fd); return fail(e,x); } return handle(e,fd); }
/* file(handle, name, mode): 0 source read, 1 private read, 2 private exclusive, 3 private lock */
static napi_value file(napi_env e,napi_callback_info i) { napi_value v[3]; int32_t mode; if(!args(e,i,3,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; char s[MAXPATHLEN]; if(!text(e,v[1],s)||!component(s)||napi_get_value_int32(e,v[2],&mode)!=napi_ok||mode<0||mode>3) return invalid(e); int flags=O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK|(mode>=2?O_RDWR:O_RDONLY); if(mode==2) flags|=O_CREAT|O_EXCL; if(mode==3) flags|=O_CREAT; int fd=openat_retry(h->fd,s,flags,0600); if(fd<0) return fail(e,errno); if(checked(fd,mode==0?3:2)<0) { int x=errno; close(fd); return fail(e,x); } return handle(e,fd); }
static napi_value close_fd(napi_env e,napi_callback_info i) { napi_value v[1],out; if(!args(e,i,1,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; int fd=h->fd; h->fd=-1; if(close(fd)<0) return fail(e,errno); napi_get_undefined(e,&out); return out; }
static napi_value fd_number(napi_env e,napi_callback_info i) { napi_value v[1],out; if(!args(e,i,1,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; napi_create_int32(e,h->fd,&out); return out; }
static napi_value identity(napi_env e,napi_callback_info i) { napi_value v[1],out,a; struct stat st; if(!args(e,i,1,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; if(fstat(h->fd,&st)<0) return fail(e,errno); napi_create_object(e,&out); napi_create_bigint_uint64(e,(uint64_t)st.st_dev,&a); napi_set_named_property(e,out,"dev",a); napi_create_bigint_uint64(e,(uint64_t)st.st_ino,&a); napi_set_named_property(e,out,"ino",a); napi_create_uint32(e,(uint32_t)(st.st_mode&S_IFMT),&a); napi_set_named_property(e,out,"type",a); return out; }
static napi_value mutation(napi_env e,napi_callback_info i) { napi_value v[4],out; int32_t op; if(!args(e,i,4,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; char a[MAXPATHLEN], b[MAXPATHLEN]; if(napi_get_value_int32(e,v[2],&op)!=napi_ok || op<0 || op>2 || !text(e,v[1],a) || !component(a)) return invalid(e); if(op==0 && (!text(e,v[3],b) || !component(b))) return invalid(e); int rc=op==0?renameat(h->fd,a,h->fd,b):unlinkat(h->fd,a,op==2?AT_REMOVEDIR:0); if(rc<0) return fail(e,errno); napi_get_undefined(e,&out); return out; }
static napi_value names(napi_env e,napi_callback_info i) { napi_value v[1],out,item; if(!args(e,i,1,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; int fd=openat_retry(h->fd,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC,0); if(fd<0) return fail(e,errno); DIR *d=fdopendir(fd); if(!d) { int x=errno; close(fd); return fail(e,x); } napi_create_array(e,&out); uint32_t n=0; struct dirent *entry; errno=0; while((entry=readdir(d))) { if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")) continue; if(napi_create_string_utf8(e,entry->d_name,NAPI_AUTO_LENGTH,&item)!=napi_ok || napi_set_element(e,out,n++,item)!=napi_ok) { closedir(d); return fail(e,EIO); } errno=0; } int x=errno; closedir(d); if(x) return fail(e,x); return out; }
static napi_value space(napi_env e,napi_callback_info i) { napi_value v[1],out; struct statvfs st; if(!args(e,i,1,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; if(fstatvfs(h->fd,&st)<0) return fail(e,errno); napi_create_bigint_uint64(e,(uint64_t)st.f_bavail*(uint64_t)st.f_frsize,&out); return out; }
static napi_value sync_fd(napi_env e,napi_callback_info i) { napi_value v[1],out; if(!args(e,i,1,v)) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; int rc; do { rc=fsync(h->fd); } while(rc<0&&errno==EINTR); if(rc<0) return fail(e,errno); napi_get_undefined(e,&out); return out; }
static napi_value lock_fd(napi_env e,napi_callback_info i) { napi_value v[2],out; bool acquire; if(!args(e,i,2,v)||napi_get_value_bool(e,v[1],&acquire)!=napi_ok) return invalid(e); owned_fd *h=get(e,v[0]); if(!h) return NULL; int rc; do { rc=flock(h->fd,acquire?(LOCK_EX|LOCK_NB):LOCK_UN); } while(rc<0&&errno==EINTR); if(rc<0 && !(acquire && (errno==EWOULDBLOCK || errno==EAGAIN))) return fail(e,errno); napi_get_boolean(e,rc==0,&out); return out; }
static napi_value init(napi_env e,napi_value exports) { napi_property_descriptor props[] = { {"root",0,root,0,0,0,napi_default,0},{"child",0,child,0,0,0,napi_default,0},{"file",0,file,0,0,0,napi_default,0},{"close",0,close_fd,0,0,0,napi_default,0},{"fd",0,fd_number,0,0,0,napi_default,0},{"identity",0,identity,0,0,0,napi_default,0},{"mutation",0,mutation,0,0,0,napi_default,0},{"names",0,names,0,0,0,napi_default,0},{"space",0,space,0,0,0,napi_default,0},{"sync",0,sync_fd,0,0,0,napi_default,0},{"lock",0,lock_fd,0,0,0,napi_default,0} }; napi_define_properties(e,exports,sizeof(props)/sizeof(props[0]),props); return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
