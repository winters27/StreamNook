/**
 * useSpeedTest - Quick baseline speed test hook
 * 
 * Simpler hook for running just the baseline network speed test
 * without the full quality iteration.
 */

import { useReducer, useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { SPEED_TEST_PHASES, type SpeedTestPhase, getRecommendedQuality, getRecommendationMessage } from '../constants/network';
import type { BaselineSpeedResult, Settings } from '../types';

// Live speed update from backend
interface LiveSpeedUpdate {
  current_mbps: number;
  phase: 'download' | 'upload';
  iteration: number;
  total_iterations: number;
}

// ============================================================================
// Types
// ============================================================================

export interface SpeedTestState {
  phase: SpeedTestPhase;
  progress: number;
  liveSpeed: LiveSpeedUpdate | null;
  result: BaselineSpeedResult | null;
  error: string | null;
}

type SpeedTestAction =
  | { type: 'START' }
  | { type: 'UPDATE_PROGRESS'; payload: number }
  | { type: 'UPDATE_LIVE_SPEED'; payload: LiveSpeedUpdate }
  | { type: 'COMPLETE'; payload: BaselineSpeedResult }
  | { type: 'ERROR'; payload: string }
  | { type: 'DISMISS' };

// ============================================================================
// Reducer
// ============================================================================

const initialState: SpeedTestState = {
  phase: SPEED_TEST_PHASES.IDLE,
  progress: 0,
  liveSpeed: null,
  result: null,
  error: null,
};

function speedTestReducer(
  state: SpeedTestState,
  action: SpeedTestAction
): SpeedTestState {
  switch (action.type) {
    case 'START':
      return {
        ...initialState,
        phase: SPEED_TEST_PHASES.TESTING,
        progress: 0,
      };

    case 'UPDATE_PROGRESS':
      return {
        ...state,
        progress: Math.min(action.payload, 95), // Cap at 95% until complete
      };

    case 'UPDATE_LIVE_SPEED':
      return {
        ...state,
        liveSpeed: action.payload,
        // Calculate progress based on iterations (total = 6 download + 3 upload = 9)
        progress: Math.min(
          action.payload.phase === 'download'
            ? (action.payload.iteration / 9) * 100
            : ((6 + action.payload.iteration) / 9) * 100,
          95
        ),
      };

    case 'COMPLETE':
      return {
        ...state,
        phase: SPEED_TEST_PHASES.COMPLETE,
        progress: 100,
        result: action.payload,
      };

    case 'ERROR':
      return {
        ...state,
        phase: SPEED_TEST_PHASES.ERROR,
        error: action.payload,
      };

    case 'DISMISS':
      return initialState;

    default:
      return state;
  }
}

// ============================================================================
// Hook
// ============================================================================

interface UseSpeedTestOptions {
  settings: Settings;
  updateSettings: (settings: Settings) => void;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export function useSpeedTest({
  settings,
  updateSettings,
  addToast,
}: UseSpeedTestOptions) {
  const [state, dispatch] = useReducer(speedTestReducer, initialState);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Listen for live speed updates from backend
  useEffect(() => {
    let mounted = true;
    
    const setupListener = async () => {
      unlistenRef.current = await listen<LiveSpeedUpdate>(
        'speed-test-live-update',
        (event) => {
          if (mounted) {
            dispatch({ type: 'UPDATE_LIVE_SPEED', payload: event.payload });
          }
        }
      );
    };
    
    setupListener();
    
    return () => {
      mounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  const cleanup = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, []);

  const runTest = useCallback(async () => {
    dispatch({ type: 'START' });
    cleanup();

    try {
      const result = await invoke<BaselineSpeedResult>('run_baseline_speed_test');

      cleanup();
      dispatch({ type: 'COMPLETE', payload: result });

      // Save to settings
      updateSettings({
        ...settings,
        network: {
          ...settings.network,
          last_baseline_result: result,
          last_test_timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      cleanup();
      dispatch({ type: 'ERROR', payload: String(error) });
      addToast(`Speed test failed: ${error}`, 'error');
    }
  }, [settings, updateSettings, addToast, cleanup]);

  const dismiss = useCallback(() => {
    dispatch({ type: 'DISMISS' });
  }, []);

  // Derived state
  const isTesting = state.phase === SPEED_TEST_PHASES.TESTING;
  const isComplete = state.phase === SPEED_TEST_PHASES.COMPLETE;
  const hasError = state.phase === SPEED_TEST_PHASES.ERROR;

  // Quality recommendation based on speed
  const getQualityRecommendation = useCallback(() => {
    if (!state.result) return null;

    const mbps = state.result.download_mbps;
    return {
      quality: getRecommendedQuality(mbps),
      message: getRecommendationMessage(mbps),
    };
  }, [state.result]);

  return {
    // State
    state,
    isTesting,
    isComplete,
    hasError,
    
    // Actions
    runTest,
    dismiss,
    
    // Helpers
    getQualityRecommendation,
  };
}


