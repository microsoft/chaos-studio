<#
.SYNOPSIS
  Windows Job Object launcher/killer for the deterministic smoke harness.

.DESCRIPTION
  Node's child_process has no Job Object support, and `taskkill /t` cannot reach a
  re-parented grandchild once the root child has already exited (its exit code 128,
  "process not found", would then be mistaken for a clean tree kill). A Windows Job
  Object fixes this: job membership is INHERITED by every descendant and SURVIVES the
  root's exit, so terminating the job kills the ENTIRE tree atomically.

  Two modes:
    -Mode launch : create a named job with KILL_ON_JOB_CLOSE, then start
                   `<NodeExe> <Bundle>` with PROC_THREAD_ATTRIBUTE_JOB_LIST so the child
                   is assigned to the job ATOMICALLY at creation, and publish the
                   readiness marker (-ReadyFile). Atomic association means there is NO
                   window in which the child exists outside the job: even if the launcher
                   is killed the instant after CreateProcess returns, the child is already
                   a job member, so closing the launcher's (only) job handle triggers
                   KILL_ON_JOB_CLOSE and reaps the whole tree — nothing can leak a
                   suspended orphan. Every grandchild the child spawns inherits job
                   membership. The readiness marker (written once the child exists) lets
                   the harness prefer the verified kill-via-job path; before it appears
                   the harness terminates the launcher (which, via KILL_ON_JOB_CLOSE,
                   still reaps any child that was already created). The child runs with a
                   SCRUBBED, deterministic environment and inherits the launcher's stdio.
                   The launcher stays OUTSIDE the job so it survives to report the child's
                   exit code; on completion it TerminateJobObject's any lingering
                   descendant and closes the handle.
    -Mode kill   : open the named job and TerminateJobObject it, then AWAIT verified
                   termination by polling until the named job no longer exists
                   (its last handle closed => the job object is gone => tree gone).

  Exit codes: launch => the child's exit code; kill => 0 on verified termination,
  or 3 if the job could not be confirmed gone within the deadline.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('launch', 'kill')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$JobName,
  [string]$NodeExe,
  [string]$Bundle,
  [string]$ReadyFile,
  [int]$VerifyTimeoutMs = 5000
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ChaosJob
{
    public const uint JOB_OBJECT_ALL_ACCESS = 0x1F001F;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    public const uint STARTF_USESTDHANDLES = 0x00000100;
    public const uint INFINITE = 0xFFFFFFFF;
    // PROC_THREAD_ATTRIBUTE_JOB_LIST: assigns the new process to a job ATOMICALLY at
    // creation, so there is no window in which the process exists outside the job.
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000D;
    public const int STD_INPUT_HANDLE = -10;
    public const int STD_OUTPUT_HANDLE = -11;
    public const int STD_ERROR_HANDLE = -12;
    // OpenJobObject sets this last-error when the named job does not exist; it is the
    // ONLY open failure that proves the job is gone (any other error is unverifiable).
    public const int ERROR_FILE_NOT_FOUND = 2;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    // Extended CreateProcess taking a STARTUPINFOEX (with an attribute list) so the
    // process can be assigned to a job ATOMICALLY at creation.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // Create a named job with KILL_ON_JOB_CLOSE. The launcher does NOT assign itself:
    // a process inside a KILL_ON_JOB_CLOSE job is terminated the instant the last job
    // handle closes, which would kill the launcher before it could report the child's
    // exit code. Only the child is assigned (below).
    public static IntPtr CreateKillOnCloseJob(string name)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(len);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)len))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return job;
    }

    // Double-null-terminated Unicode environment block with ONLY the scrubbed vars the
    // Node child needs plus the explicit self-test signal (no inherited INPUT_*/tokens).
    private static IntPtr BuildScrubbedEnv()
    {
        StringBuilder sb = new StringBuilder();
        string path = Environment.GetEnvironmentVariable("PATH");
        sb.Append("PATH=").Append(path == null ? "" : path).Append('\0');
        string sysroot = Environment.GetEnvironmentVariable("SystemRoot");
        if (!string.IsNullOrEmpty(sysroot)) { sb.Append("SystemRoot=").Append(sysroot).Append('\0'); }
        sb.Append("CHAOS_STUDIO_SMOKE_CHECK=1").Append('\0');
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    // Race-free launch via ATOMIC job association: the child is created with
    // PROC_THREAD_ATTRIBUTE_JOB_LIST, so it is a job member the instant it exists —
    // there is NO window in which it lives outside the job. This is strictly stronger
    // than the classic CreateProcess(CREATE_SUSPENDED) => AssignProcessToJobObject =>
    // ResumeThread sequence, which leaves a window (the suspended child exists before
    // the separate AssignProcessToJobObject call) in which a killed launcher would
    // orphan the child; atomic association has no such window and needs no suspend or
    // resume. Because the launcher holds the only job handle and the job is
    // KILL_ON_JOB_CLOSE, killing the launcher at ANY time closes that handle and reaps
    // the whole tree; the readiness marker (published once the child exists) lets the
    // harness prefer the verified kill-via-job path. Returns the child's exit code; the
    // launcher itself is never a job member.
    public static int RunInJobAtomic(string jobName, string nodeExe, string bundle, string readyFile)
    {
        IntPtr job = CreateKillOnCloseJob(jobName);
        IntPtr env = IntPtr.Zero;
        IntPtr attrList = IntPtr.Zero;
        IntPtr jobPtr = IntPtr.Zero;
        bool attrInit = false;
        try
        {
            env = BuildScrubbedEnv();

            // Build a process/thread attribute list carrying the job handle so
            // CreateProcess assigns the child to the job atomically.
            IntPtr lpSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize); // query size
            attrList = Marshal.AllocHGlobal(lpSize);
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref lpSize))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
            }
            attrInit = true;
            jobPtr = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobPtr, job);
            if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobPtr, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute (job list) failed");
            }

            STARTUPINFOEX siex = new STARTUPINFOEX();
            siex.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            siex.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            siex.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            siex.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            siex.lpAttributeList = attrList;

            string cmd = "\"" + nodeExe + "\" \"" + bundle + "\"";
            PROCESS_INFORMATION pi;
            bool ok = CreateProcess(
                null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, env, null, ref siex, out pi);
            if (!ok)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess (atomic job) failed");
            }
            try
            {
                // The child already exists AND is a job member (atomic). Publish
                // readiness, then wait for it to exit and read its code.
                SignalReady(readyFile);
                WaitForSingleObject(pi.hProcess, INFINITE);
                uint code;
                if (!GetExitCodeProcess(pi.hProcess, out code))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
                }
                return unchecked((int)code);
            }
            finally
            {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
            }
        }
        finally
        {
            // Reap any descendant still alive (the child already exited), then release.
            TerminateJobObject(job, 1);
            CloseHandle(job);
            if (attrInit) { DeleteProcThreadAttributeList(attrList); }
            if (attrList != IntPtr.Zero) { Marshal.FreeHGlobal(attrList); }
            if (jobPtr != IntPtr.Zero) { Marshal.FreeHGlobal(jobPtr); }
            if (env != IntPtr.Zero) { Marshal.FreeHGlobal(env); }
        }
    }

    // Atomically publish the readiness marker file (best-effort). Written the instant
    // the child becomes a job member so the harness can distinguish "job exists with a
    // member" (safe to kill via the job) from "job not created yet" (must terminate
    // the launcher). A temp-then-move keeps a partial file from ever being observed.
    private static void SignalReady(string readyFile)
    {
        if (string.IsNullOrEmpty(readyFile)) { return; }
        try
        {
            string tmp = readyFile + ".tmp";
            System.IO.File.WriteAllText(tmp, "ready");
            if (System.IO.File.Exists(readyFile)) { System.IO.File.Delete(readyFile); }
            System.IO.File.Move(tmp, readyFile);
        }
        catch { /* best-effort: the harness also has a fail-closed launcher-kill path */ }
    }

    // Returns true ONLY if the named job is verifiably GONE. OpenJobObject failing does
    // NOT by itself prove the job is gone: only ERROR_FILE_NOT_FOUND does. Any other
    // failure (e.g. ERROR_ACCESS_DENIED) means we could NOT verify — treat as NOT gone
    // (fail closed) so the caller keeps polling and ultimately reports non-termination.
    public static bool IsGone(string name)
    {
        IntPtr h = OpenJobObject(JOB_OBJECT_ALL_ACCESS, false, name);
        if (h != IntPtr.Zero) { CloseHandle(h); return false; }
        int err = Marshal.GetLastWin32Error();
        return err == ERROR_FILE_NOT_FOUND;
    }

    // Terminate the named job (kills every member of the tree). Returns:
    //   0 = TerminateJobObject succeeded (termination initiated);
    //   1 = the job was already gone (OpenJobObject => ERROR_FILE_NOT_FOUND);
    //   2 = ERROR (could not open the job for a reason OTHER than not-found, or
    //       TerminateJobObject FAILED). A job-open or termination error is NEVER
    //       treated as success — the caller fails closed and reaps the launcher.
    public static int KillByName(string name)
    {
        IntPtr h = OpenJobObject(JOB_OBJECT_ALL_ACCESS, false, name);
        if (h == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            return err == ERROR_FILE_NOT_FOUND ? 1 : 2;
        }
        try
        {
            return TerminateJobObject(h, 1) ? 0 : 2;
        }
        finally { CloseHandle(h); }
    }
}
'@

if ($Mode -eq 'launch') {
    if (-not $NodeExe -or -not $Bundle) { throw 'launch mode requires -NodeExe and -Bundle' }
    $childExit = [ChaosJob]::RunInJobAtomic($JobName, $NodeExe, $Bundle, $ReadyFile)
    exit $childExit
}
else {
    # kill: terminate the tree, then AWAIT verified termination (job object gone).
    $killResult = [ChaosJob]::KillByName($JobName)
    if ($killResult -eq 1) { exit 0 }   # already gone — nothing to reap
    if ($killResult -eq 2) { exit 3 }   # open/terminate ERROR — could not verify; fail closed
    # Termination initiated (0): poll until the job is verifiably gone.
    $deadline = (Get-Date).AddMilliseconds($VerifyTimeoutMs)
    while ((Get-Date) -lt $deadline) {
        if ([ChaosJob]::IsGone($JobName)) { exit 0 }
        Start-Sleep -Milliseconds 100
    }
    if ([ChaosJob]::IsGone($JobName)) { exit 0 }
    exit 3
}
