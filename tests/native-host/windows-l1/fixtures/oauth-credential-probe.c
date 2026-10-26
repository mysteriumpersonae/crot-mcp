/* Native Win32 evidence, not an FFI stand-in. Never prints credential bytes. */
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <wincred.h>
#include <stdio.h>
int wmain(int argc, wchar_t **argv) {
  PCREDENTIALW credential = NULL;
  if (argc != 2) return 90;
  BOOL read = CredReadW(argv[1], CRED_TYPE_GENERIC, 0, &credential);
  DWORD error = read ? 0 : GetLastError();
  if (credential) CredFree(credential);
  printf("{\"read\":%s,\"error\":%lu}\n", read ? "true" : "false", (unsigned long)error);
  return 0;
}
