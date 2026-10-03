# Native-provider assertion: inspect only persistence, never credential blob contents.
param([Parameter(Mandatory=$true)][string]$Name)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FidyCredentialPersistence {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void Free(IntPtr credential);
}
'@
$pointer = [IntPtr]::Zero
try {
  $found = [FidyCredentialPersistence]::Read("com.fidy.cli.api.fidyapp.com/$Name", 1, 0, [ref]$pointer)
  if (-not $found) { exit 1 }
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][FidyCredentialPersistence+Credential])
  if ($credential.Type -ne 1 -or $credential.Persist -ne 2) { exit 1 }
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [FidyCredentialPersistence]::Free($pointer) }
}
