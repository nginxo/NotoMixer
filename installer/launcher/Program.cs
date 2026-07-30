using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        string installRoot = AppDomain.CurrentDomain.BaseDirectory
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string runtimeExecutable = Path.Combine(
            installRoot,
            "reserved",
            "notoMixer.exe"
        );

        if (!File.Exists(runtimeExecutable))
        {
            MessageBox.Show(
                "NotoMixer's files have not been found.\n\n" +
                "Reinstall the app or contact support.",
                "NotoMixer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 2;
        }

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = runtimeExecutable,
                WorkingDirectory = installRoot,
                UseShellExecute = false,
                Arguments = BuildArguments(args)
            };
            startInfo.EnvironmentVariables["NOTOMIXER_INSTALL_ROOT"] = installRoot;
            Process.Start(startInfo);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Can't start NotoMixer.\n\n" + error.Message,
                "NotoMixer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }

    private static string BuildArguments(string[] args)
    {
        StringBuilder result = new StringBuilder();
        foreach (string argument in args)
        {
            if (result.Length > 0)
            {
                result.Append(' ');
            }
            result.Append(QuoteArgument(argument));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 &&
            argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return argument;
        }

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;

        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }

            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }

            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }

        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
