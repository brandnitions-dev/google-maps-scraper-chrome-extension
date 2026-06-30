// Chrome Native Messaging manifests only allow a single "path" executable with no CLI args (stable Chrome).
// This launcher is that executable; it forwards stdin/stdout verbatim to EmailEnricher\.venv python running
// gmapsagent_enrich_host.py. Build with build_launcher.bat (csc.exe from .NET Framework).

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;

internal static class Program
{
    private static int Main()
    {
        try
        {
            string location = Assembly.GetExecutingAssembly().Location;
            string hostDir = Path.GetFullPath(Path.GetDirectoryName(location) ?? string.Empty);
            string enricherRoot = Path.GetFullPath(Path.Combine(hostDir, ".."));
            string python = Path.Combine(enricherRoot, ".venv", "Scripts", "python.exe");
            string script = Path.Combine(hostDir, "gmapsagent_enrich_host.py");

            if (!File.Exists(python))
            {
                return 21;
            }
            if (!File.Exists(script))
            {
                return 22;
            }

            var psi = new ProcessStartInfo
            {
                FileName = python,
                Arguments = "\"" + script + "\"",
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = enricherRoot,
            };

            using (Process proc = Process.Start(psi))
            {
                if (proc == null)
                    return 23;

                Stream parentIn = Console.OpenStandardInput();
                Stream parentOut = Console.OpenStandardOutput();
                Stream parentErr = Console.OpenStandardError();

                Task cerr = proc.StandardError.BaseStream.CopyToAsync(parentErr);

                Task cin = Task.Run(async () =>
                {
                    await parentIn.CopyToAsync(proc.StandardInput.BaseStream).ConfigureAwait(false);
                    try
                    {
                        proc.StandardInput.Close();
                    }
                    catch { }
                });

                Task cout = proc.StandardOutput.BaseStream.CopyToAsync(parentOut);

                Task.WhenAll(cin, cout, cerr).Wait();
                proc.WaitForExit();

                int code = proc.ExitCode;

                return code != 0 ? code : 0;
            }
        }
        catch (Exception)
        {
            return 30;
        }
    }
}
