/**
 * NetworkSettings - Network speed test settings panel
 * Clean, minimal design with centered action
 */

import { Download, Upload, Activity } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { useSpeedTest } from '../../hooks/useSpeedTest';
import { SPEED_TEST_PHASES } from '../../constants/network';
import { Speedometer } from './network';

const NetworkSettings = () => {
  const { settings, updateSettings, addToast } = useAppStore();

  const speedTest = useSpeedTest({
    settings,
    updateSettings,
    addToast,
  });

  const { state } = speedTest;
  const isIdle = state.phase === SPEED_TEST_PHASES.IDLE;
  const isTesting = state.phase === SPEED_TEST_PHASES.TESTING;
  const isComplete = state.phase === SPEED_TEST_PHASES.COMPLETE && state.result;

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px]">
      {/* Idle State - Centered Button */}
      {isIdle && (
        <button
          onClick={speedTest.runTest}
          className="group flex flex-col items-center gap-4 p-8 rounded-2xl transition-all hover:bg-white/[0.03]"
        >
          <div className="p-5 rounded-2xl bg-gradient-to-br from-accent/20 to-purple-500/10 border border-accent/20 group-hover:scale-110 group-hover:border-accent/40 transition-all duration-300">
            <Activity size={36} className="text-accent" />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-white group-hover:text-accent transition-colors">
              Run Speed Test
            </p>
            <p className="text-sm text-gray-500 mt-1">
              ~30 seconds via Cloudflare
            </p>
          </div>
        </button>
      )}

      {/* Testing State */}
      {isTesting && (
        <div className="text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/20 mb-6">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-sm font-medium text-accent">
              {state.liveSpeed?.phase === 'upload' ? 'Testing Upload' : 'Testing Download'}
            </span>
          </div>
          <Speedometer value={state.liveSpeed?.current_mbps ?? 0} />
          <p className="text-xs text-gray-500 mt-4">
            {state.liveSpeed 
              ? `Test ${state.liveSpeed.iteration} of ${state.liveSpeed.total_iterations} • Cloudflare CDN`
              : 'Connecting to Cloudflare...'
            }
          </p>
        </div>
      )}

      {/* Complete State */}
      {isComplete && state.result && (
        <div className="w-full max-w-sm">
          {/* Results Grid */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="p-4 rounded-xl bg-gradient-to-br from-accent/10 to-transparent border border-accent/10">
              <Download size={20} className="text-accent mb-2" />
              <p className="text-2xl font-bold text-white tabular-nums">
                {state.result.download_mbps.toFixed(1)}
              </p>
              <p className="text-xs text-gray-400">Mbps download</p>
            </div>
            <div className="p-4 rounded-xl bg-gradient-to-br from-purple-500/10 to-transparent border border-purple-500/10">
              <Upload size={20} className="text-purple-400 mb-2" />
              <p className="text-2xl font-bold text-white tabular-nums">
                {state.result.upload_mbps.toFixed(1)}
              </p>
              <p className="text-xs text-gray-400">Mbps upload</p>
            </div>
          </div>

          {/* Secondary Stats */}
          <div className="flex items-center justify-center gap-6 py-3 rounded-xl bg-white/[0.02] border border-white/5 mb-4">
            <div className="text-center">
              <p className="text-lg font-semibold text-white tabular-nums">{state.result.latency_ms}<span className="text-xs text-gray-500 ml-1">ms</span></p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">Latency</p>
            </div>
            <div className="w-px h-8 bg-white/10" />
            <div className="text-center">
              <p className="text-lg font-semibold text-white tabular-nums">{state.result.stability_score}<span className="text-xs text-gray-500 ml-1">%</span></p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">Stability</p>
            </div>
          </div>

          {/* Server Info */}
          <p className="text-[11px] text-gray-600 text-center mb-4">
            Tested via {state.result.test_server}
          </p>

          {/* Run Again */}
          <button
            onClick={speedTest.runTest}
            className="w-full py-3 rounded-xl text-sm font-medium text-gray-400 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 transition-all flex items-center justify-center gap-2"
          >
            <Activity size={16} />
            Run Again
          </button>

          {/* Dismiss */}
          <button
            onClick={speedTest.dismiss}
            className="w-full py-2 mt-2 text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            Clear Results
          </button>
        </div>
      )}
    </div>
  );
};

export default NetworkSettings;
