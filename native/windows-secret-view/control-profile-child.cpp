// AD-55: fixed diagnostic child. OS SDK only; never an actor/backend.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <cwchar>
#include <cstring>
#include <string>
#include <vector>
#include <sddl.h>
#include "control-profile-token.h"
namespace {
using NtCreate = NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,
    PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
bool info(HANDLE token,TOKEN_INFORMATION_CLASS type,std::vector<unsigned char>& out) {
  DWORD n=0; GetTokenInformation(token,type,nullptr,0,&n);
  if (n<4 || n>65536) return false;
  out.resize(n); return !!GetTokenInformation(token,type,out.data(),n,&n);
}
unsigned classify(HANDLE h,DWORD error) {
  if (h!=INVALID_HANDLE_VALUE && h) return CloseHandle(h)?1u:3u;
  if (error==ERROR_ACCESS_DENIED) return 0;
  if (error==ERROR_FILE_NOT_FOUND || error==ERROR_PATH_NOT_FOUND) return 2;
  return 3;
}
unsigned nativeOpen(NtCreate create,const std::wstring& device,ACCESS_MASK access,bool metadata=true) {
  UNICODE_STRING name{}; name.Buffer=const_cast<PWSTR>(device.c_str());
  name.Length=static_cast<USHORT>(device.size()*2); name.MaximumLength=name.Length;
  OBJECT_ATTRIBUTES a{}; a.Length=sizeof(a); a.ObjectName=&name; a.Attributes=0x40;
  IO_STATUS_BLOCK io{}; HANDLE h=INVALID_HANDLE_VALUE;
  // Metadata mode mirrors Win32 minimum access; literal mode independently
  // requests zero with the same non-directory option. Never merge outcomes.
  const NTSTATUS s=create(&h,access|(metadata?(FILE_READ_ATTRIBUTES|SYNCHRONIZE):0),&a,&io,nullptr,0,7,1,0x40,nullptr,0);
  if (s>=0 && h && h!=INVALID_HANDLE_VALUE) return CloseHandle(h)?1u:3u;
  if (h && h!=INVALID_HANDLE_VALUE && !CloseHandle(h)) return 3;
  if (s==static_cast<NTSTATUS>(0xc0000022)) return 0;
  if (s==static_cast<NTSTATUS>(0xc0000034) || s==static_cast<NTSTATUS>(0xc000003a)) return 2;
  return 3;
}
}
int wmain(int argc,wchar_t** argv) {
  // Fixed bounded diagnostic frame in exit status; absence means NOT ready.
  if (argc!=5 || (wcscmp(argv[2],L"0") && wcscmp(argv[2],L"1"))) return 2;
  const std::wstring device=argv[1];
  if (device.size()!=52 || device.compare(0,15,L"\\Device\\Volume{") || device.back()!=L'}' ||
      device.find_first_not_of(L"0123456789abcdefABCDEF-",15)<device.size()-1) return 2;
  HANDLE token=nullptr;
  if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_DUPLICATE,&token)) return 3;
  std::vector<unsigned char> app,caps,il;
  ULONG lpac=0; DWORD error=0;
  bool okay=info(token,TokenIsAppContainer,app) && info(token,TokenCapabilities,caps) &&
      info(token,TokenIntegrityLevel,il) && crot_control::effectiveLpac(token,lpac,error);
  if (okay) {
    auto sid=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(il.data())->Label.Sid;
    okay=!!*reinterpret_cast<DWORD*>(app.data()) &&
        reinterpret_cast<TOKEN_GROUPS*>(caps.data())->GroupCount==0 && IsValidSid(sid) &&
        *GetSidSubAuthorityCount(sid)==1 && *GetSidSubAuthority(sid,0)==4096 &&
        !!lpac==(argv[2][0]==L'1');
  }
  if (!CloseHandle(token) || !okay) return 4;
  auto create=reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile"));
  if (!create) return 5;
  const std::wstring raw=L"\\\\?\\GLOBALROOT"+device;
  const auto rawChecks=[&]() {
    unsigned bits=0;
    for (unsigned i=0;i<2;i++) {
      HANDLE h=CreateFileW(raw.c_str(),i?GENERIC_READ:0,7,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
      const DWORD e=GetLastError(); bits|=classify(h,e)<<(i*2);
      bits|=nativeOpen(create,device,i?GENERIC_READ:0)<<((i+2)*2);
    }
    return bits|(nativeOpen(create,device,0,false)<<9);
  };
  unsigned bits=rawChecks();
  const std::wstring mount=argv[3];
  if (mount.size()>32000 || mount.find(L'"')!=std::wstring::npos || mount.size()<3 || mount.substr(1,2)!=L":\\") return 7;
  DWORD dataError=0; unsigned dataStage=1;
  // Fixed explicit directory capability, not a raw device or operation pipe.
  wchar_t* end=nullptr; const auto rootValue=wcstoull(argv[4],&end,10);
  if (!rootValue || !end || *end) return 8;
  HANDLE dataRoot=reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(rootValue));
  BY_HANDLE_FILE_INFORMATION rootInfo{};
  if (GetFileType(dataRoot)!=FILE_TYPE_DISK || !GetFileInformationByHandle(dataRoot,&rootInfo) ||
      !(rootInfo.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)) return 9;
  wchar_t leaf[]=L"public.txt";
  UNICODE_STRING relative{}; relative.Buffer=leaf; relative.Length=sizeof(leaf)-sizeof(wchar_t);
  relative.MaximumLength=sizeof(leaf);
  OBJECT_ATTRIBUTES a{}; a.Length=sizeof(a); a.RootDirectory=dataRoot; a.ObjectName=&relative; a.Attributes=0x40;
  IO_STATUS_BLOCK io{}; HANDLE data=INVALID_HANDLE_VALUE;
  const NTSTATUS opened=create(&data,GENERIC_READ|GENERIC_WRITE|SYNCHRONIZE|FILE_READ_ATTRIBUTES,
      &a,&io,nullptr,0,0,1,0x60,nullptr,0); // non-directory, synchronous non-alert
  if (opened<0 || data==INVALID_HANDLE_VALUE) {
    auto map=reinterpret_cast<ULONG(NTAPI*)(NTSTATUS)>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlNtStatusToDosError"));
    dataError=map?map(opened):ERROR_GEN_FAILURE;
    if (data && data!=INVALID_HANDLE_VALUE && !CloseHandle(data)) dataError=ERROR_INVALID_HANDLE;
    data=INVALID_HANDLE_VALUE;
  }
  else {
    char before[32]{}; DWORD read=0,written=0;
    const char initial[]="CROT-AD55-BEFORE", after[]="CROT-AD55-AFTER";
    LARGE_INTEGER zero{};
    if (!(dataStage=2,ReadFile(data,before,sizeof(before),&read,nullptr))) dataError=GetLastError();
    else if (!(dataStage=3,((read==sizeof(initial)-1 && !memcmp(before,initial,read)) ||
             (read==sizeof(after)-1 && !memcmp(before,after,read))))) dataError=0;
    else if (!(dataStage=4,SetFilePointerEx(data,zero,nullptr,FILE_BEGIN))) dataError=GetLastError();
    else if (!(dataStage=5,WriteFile(data,after,sizeof(after)-1,&written,nullptr))) dataError=GetLastError();
    else if (written!=sizeof(after)-1) dataError=ERROR_WRITE_FAULT;
    else if (!(dataStage=6,SetEndOfFile(data))) dataError=GetLastError();
    else if (!(dataStage=7,FlushFileBuffers(data))) dataError=GetLastError();
    else dataStage=0;
    if (!CloseHandle(data)) { dataStage=8; dataError=GetLastError(); }
    if (!dataStage) bits|=0x100;
  }
  if (!CloseHandle(dataRoot)) { dataStage=8; dataError=GetLastError(); bits&=~0x100u; }
  bits|=rawChecks(); // data access must not unlock raw control aliases
  // New research-only exit protocol: 0x55, bounded Win32 error, stage, raw/data
  // bits. This is deliberately distinct from historical AD-28's NUL protocol.
  return static_cast<int>(0x55000000u|((dataError<255?dataError:255)<<16)|(dataStage<<12)|bits);
}
