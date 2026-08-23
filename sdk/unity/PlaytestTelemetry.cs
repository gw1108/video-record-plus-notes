// Playtest telemetry SDK — Unity reference implementation.
// Serves current in-game time to the playtest recorder over localhost HTTP
// (protocol: docs/telemetry-protocol.md). Drop this component into a
// bootstrap scene; it survives scene loads.
//
// By default gameTimeMs is unscaled play time that freezes while
// Time.timeScale == 0 (the common pause idiom). Override GameTimeMs/IsPaused
// for a run timer, level clock, or custom pause detection.

using System;
using System.Globalization;
using System.Net;
using System.Text;
using System.Threading;
using UnityEngine;

namespace Playtest
{
    public class PlaytestTelemetry : MonoBehaviour
    {
        [Tooltip("Port the recorder polls (default 46333).")]
        public int port = 46333;

        private HttpListener _listener;
        private Thread _thread;

        // Written on the main thread every frame, read from the listener thread.
        private volatile bool _paused;
        private long _gameTimeMs; // interlocked

        /// <summary>Override for a custom clock (ms). Must not advance while paused.</summary>
        protected virtual long GameTimeMs => Interlocked.Read(ref _gameTimeMs);

        /// <summary>Override for custom pause detection.</summary>
        protected virtual bool IsPaused => Time.timeScale == 0f;

        // double, not float: past ~2 h a float's ULP exceeds the per-frame
        // delta's precision and the accumulated clock drifts by whole frames.
        private double _accumulatedMs;

        private void Awake()
        {
            DontDestroyOnLoad(gameObject);
        }

        private void Update()
        {
            _paused = IsPaused;
            if (!_paused)
            {
                _accumulatedMs += Time.unscaledDeltaTime * 1000.0;
                Interlocked.Exchange(ref _gameTimeMs, (long)_accumulatedMs);
            }
        }

        private void OnEnable()
        {
            try
            {
                _listener = new HttpListener();
                // 127.0.0.1 only — never expose this beyond the local machine.
                _listener.Prefixes.Add($"http://127.0.0.1:{port}/playtest/");
                _listener.Start();
                _thread = new Thread(Serve) { IsBackground = true, Name = "PlaytestTelemetry" };
                _thread.Start();
                Debug.Log($"[PlaytestTelemetry] serving http://127.0.0.1:{port}/playtest/time");
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[PlaytestTelemetry] could not start listener: {e.Message}");
            }
        }

        private void OnDisable()
        {
            try { _listener?.Stop(); _listener?.Close(); } catch { /* shutting down */ }
            _listener = null;
        }

        private void Serve()
        {
            while (_listener != null && _listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = _listener.GetContext(); }
                catch { return; } // listener stopped

                try
                {
                    var body = ctx.Request.Url.AbsolutePath.EndsWith("/time")
                        ? BuildTimeJson()
                        : null;
                    if (body == null)
                    {
                        ctx.Response.StatusCode = 404;
                    }
                    else
                    {
                        var bytes = Encoding.UTF8.GetBytes(body);
                        ctx.Response.ContentType = "application/json";
                        ctx.Response.ContentLength64 = bytes.Length;
                        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                    }
                    ctx.Response.Close();
                }
                catch { /* client went away; keep serving */ }
            }
        }

        private string BuildTimeJson()
        {
            long ms = GameTimeMs;
            string paused = _paused ? "true" : "false";
            return string.Format(
                CultureInfo.InvariantCulture,
                "{{\"gameTimeMs\":{0},\"paused\":{1}}}", ms, paused);
        }
    }
}
