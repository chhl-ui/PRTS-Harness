# 把 DeepSeek API key 存进 Windows Credential Manager（DPAPI 保护）。
#
# 为什么不用 cmdkey：`cmdkey /pass:<key>` 会把明文放进命令行，进程列表里能看到。
# 这里用 Read-Host -AsSecureString 交互输入，再用 CredWrite 直接写 blob。
#
# 用法：npm run secret:set
# 存好后可以删掉明文密钥文件（<dataRoot>\secrets\deepseek.key），
# PRTS 启动时会优先从凭据管理器取。
param(
    [string]$Target = 'PRTS/DeepSeek',
    [string]$User = 'prts'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PrtsCredWriter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
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

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredDeleteW(string target, uint type, uint flags);

    public static bool Write(string target, string user, string secret) {
        byte[] blob = System.Text.Encoding.Unicode.GetBytes(secret);
        IntPtr p = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, p, blob.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Type = 1;          // CRED_TYPE_GENERIC
            c.TargetName = target;
            c.UserName = user;
            c.CredentialBlobSize = (uint)blob.Length;
            c.CredentialBlob = p;
            c.Persist = 2;       // CRED_PERSIST_LOCAL_MACHINE
            return CredWriteW(ref c, 0);
        }
        finally {
            Marshal.FreeHGlobal(p);
        }
    }

    public static bool Delete(string target) {
        return CredDeleteW(target, 1, 0);
    }

    public static string LastError() {
        return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message;
    }
}
'@

$secure = Read-Host -AsSecureString "粘贴 DeepSeek API key（输入不回显）"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plain)) {
        Write-Error '空 key，未写入'
        exit 1
    }
    $ok = [PrtsCredWriter]::Write($Target, $User, $plain.Trim())
    if (-not $ok) {
        Write-Error "CredWrite 失败：$([PrtsCredWriter]::LastError())"
        exit 1
    }
    Write-Host "已写入凭据管理器：$Target"
    Write-Host '现在可以删除明文密钥文件（<dataRoot>\secrets\deepseek.key）——'
    Write-Host 'PRTS 启动时会优先从凭据管理器取，文件只在取不到时才作为回退。'
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $plain = $null
    $secure = $null
}
