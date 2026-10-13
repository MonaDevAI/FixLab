using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace FixLab
{
    public static class WindowsExecutor
    {
        const uint CreateSuspended = 0x00000004;
        const uint CreateNewConsole = 0x00000010;
        const uint UseShowWindow = 0x00000001;
        const uint UseStandardHandles = 0x00000100;
        const uint KillOnJobClose = 0x00002000;
        const uint WaitTimeout = 258;

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperations, WriteOperations, OtherOperations;
            public ulong ReadBytes, WriteBytes, OtherBytes;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct Accounting
        {
            public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct Startup
        {
            public uint Size;
            public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
            public ushort ShowWindow, ReservedSize;
            public IntPtr ReservedBytes, Input, Output, Error;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo
        {
            public IntPtr Process, Thread;
            public uint ProcessId, ThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
            string directory, ref Startup startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit,
            out long kernel, out long user);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        static void Check(bool succeeded)
        {
            if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        static uint ActiveProcesses(IntPtr job)
        {
            Accounting accounting;
            Check(QueryInformationJobObject(job, 1, out accounting,
                (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
            return accounting.ActiveProcesses;
        }

        static void WaitForEmptyJob(IntPtr job)
        {
            while (ActiveProcesses(job) != 0) Thread.Sleep(20);
        }

        public static int Run(string executable, string command, string directory,
            string stopPath, string proofPath, string nonce, bool retainDescendants, uint ownerPid)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr owner = IntPtr.Zero;
            ProcessInfo process = new ProcessInfo();
            bool assigned = false;
            bool quiescent = false;
            int result = 1;
            try
            {
                owner = OpenProcess(0x00101000, false, ownerPid);
                Check(owner != IntPtr.Zero);
                long ownerCreation, supervisorCreation, exitTime, kernelTime, userTime;
                Check(GetProcessTimes(owner, out ownerCreation, out exitTime, out kernelTime, out userTime));
                Check(GetProcessTimes(new IntPtr(-1), out supervisorCreation, out exitTime, out kernelTime, out userTime));
                if (ownerCreation > supervisorCreation)
                    throw new InvalidOperationException("Windows executor owner generation changed");
                job = CreateJobObject(IntPtr.Zero, null);
                Check(job != IntPtr.Zero);
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.Flags = KillOnJobClose;
                Check(SetInformationJobObject(job, 9, ref limits,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                if (File.Exists(stopPath))
                {
                    quiescent = true;
                    result = 130;
                }
                else
                {
                    Startup startup = new Startup();
                    startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
                    // Descendant tools inherit this hidden console instead of opening their own.
                    startup.Flags = UseStandardHandles | UseShowWindow;
                    startup.ShowWindow = 0;
                    startup.Input = GetStdHandle(-10);
                    startup.Output = GetStdHandle(-11);
                    startup.Error = GetStdHandle(-12);
                    Check(SetHandleInformation(startup.Input, 1, 1));
                    Check(SetHandleInformation(startup.Output, 1, 1));
                    Check(SetHandleInformation(startup.Error, 1, 1));
                    Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero,
                        IntPtr.Zero, true, CreateSuspended | CreateNewConsole, IntPtr.Zero,
                        directory, ref startup, out process));
                    Check(AssignProcessToJobObject(job, process.Process));
                    assigned = true;
                    Check(ResumeThread(process.Thread) != UInt32.MaxValue);
                    bool stopping = false;
                    while (ActiveProcesses(job) != 0)
                    {
                        uint wait = WaitForSingleObject(process.Process, 0);
                        Check(wait == 0 || wait == WaitTimeout);
                        uint ownerWait = WaitForSingleObject(owner, 0);
                        Check(ownerWait == 0 || ownerWait == WaitTimeout);
                        if (!stopping && (File.Exists(stopPath) || ownerWait == 0 || (wait == 0 && !retainDescendants)))
                        {
                            Check(TerminateJobObject(job, 130));
                            stopping = true;
                        }
                        Thread.Sleep(20);
                    }
                    quiescent = true;
                    uint exitCode;
                    Check(GetExitCodeProcess(process.Process, out exitCode));
                    result = File.Exists(stopPath) ? 130 : unchecked((int)exitCode);
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("FixLab Windows containment failed: " + error.Message);
                result = 1;
            }
            finally
            {
                try
                {
                    if (process.Process == IntPtr.Zero)
                    {
                        quiescent = true;
                    }
                    else if (!quiescent)
                    {
                        if (assigned)
                        {
                            Check(TerminateJobObject(job, 1));
                            WaitForEmptyJob(job);
                        }
                        else
                        {
                            Check(TerminateProcess(process.Process, 1));
                            Check(WaitForSingleObject(process.Process, UInt32.MaxValue) == 0);
                        }
                        quiescent = true;
                    }
                    if (quiescent)
                    {
                        File.WriteAllText(proofPath + ".tmp",
                            "{\"nonce\":\"" + nonce + "\",\"pid\":" + GetCurrentProcessId() +
                            ",\"quiescent\":true}", new UTF8Encoding(false));
                        File.Move(proofPath + ".tmp", proofPath);
                    }
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("FixLab Windows termination could not be verified: " + error.Message);
                    result = 1;
                }
                if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                if (job != IntPtr.Zero) CloseHandle(job);
                if (owner != IntPtr.Zero) CloseHandle(owner);
            }
            return result;
        }
    }
}
