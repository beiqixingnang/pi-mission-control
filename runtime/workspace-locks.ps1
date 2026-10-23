$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
# Read only the current-directory field of 64-bit processes. No process or
# remote memory is modified; inaccessible/unsupported processes are skipped.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MissionWorkspaceCwd {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInfo {
        public IntPtr Reserved1, Peb, Reserved2a, Reserved2b, Pid, Reserved3;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr count, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int kind, ref BasicInfo info, uint size, out uint returned);
    private static byte[] Read(IntPtr process, IntPtr address, int length) {
        byte[] data = new byte[length]; UIntPtr read;
        if (!ReadProcessMemory(process, address, data, (UIntPtr)length, out read) || read.ToUInt64() != (ulong)length)
            throw new InvalidOperationException("Directory field unavailable");
        return data;
    }
    public static string Directory(int pid) {
        if (!Environment.Is64BitProcess) return null;
        IntPtr process = OpenProcess(0x410, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            bool wow64;
            if (!IsWow64Process(process, out wow64) || wow64) return null;
            BasicInfo info = new BasicInfo(); uint returned;
            if (NtQueryInformationProcess(process, 0, ref info, (uint)Marshal.SizeOf(typeof(BasicInfo)), out returned) != 0)
                return null;
            IntPtr parameters = new IntPtr(BitConverter.ToInt64(Read(process, IntPtr.Add(info.Peb, 0x20), 8), 0));
            byte[] current = Read(process, IntPtr.Add(parameters, 0x38), 16);
            int length = BitConverter.ToUInt16(current, 0);
            if (length < 2 || length > 32766 || length % 2 != 0) return null;
            IntPtr buffer = new IntPtr(BitConverter.ToInt64(current, 8));
            return Encoding.Unicode.GetString(Read(process, buffer, length));
        } catch { return null; }
        finally { CloseHandle(process); }
    }
}
'@
$root = [IO.Path]::GetFullPath([string]$request.root).TrimEnd('\')
$names = @('node.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe', 'Code.exe', 'Lingma.exe', 'WindowsTerminal.exe', 'OpenConsole.exe', 'git.exe', 'bash.exe', 'python.exe', 'python3.exe', 'devenv.exe', 'clangd.exe', 'rust-analyzer.exe')
$holders = @()
$inspected = 0
foreach ($process in Get-CimInstance Win32_Process) {
    if ($process.ProcessId -eq $PID -or $process.ProcessId -eq $request.leadPid -or $names -notcontains $process.Name) { continue }
    $cwd = [MissionWorkspaceCwd]::Directory([int]$process.ProcessId)
    if (-not $cwd) { continue }
    $inspected++
    $cwd = $cwd.TrimEnd('\')
    if ($cwd.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $cwd.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $holders += [pscustomobject]@{
            pid = [int]$process.ProcessId
            parentPid = [int]$process.ParentProcessId
            name = [string]$process.Name
            cwd = $cwd
            parentOfPi = ($process.ProcessId -eq $request.parentPid)
        }
    }
}
[pscustomobject]@{ supported = $true; kind = 'process-cwd'; inspected = $inspected; exhaustive = $false; holders = @($holders) } | ConvertTo-Json -Depth 4 -Compress
