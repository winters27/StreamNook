import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Trophy, Users, ChevronDown, ChevronUp, Hourglass, PartyPopper, Frown, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';

// Channel Points Icon (Twitch style)
const ChannelPointsIcon = ({ className = "", size = 14 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
    <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
  </svg>
);
import { useAppStore } from '../stores/AppStore';

interface PredictionOutcome {
  id: string;
  title: string;
  color: string;
  total_points: number;
  total_users: number;
}

interface PredictionData {
  channel_id: string;
  prediction_id: string;
  title: string;
  outcomes: PredictionOutcome[];
  prediction_window_seconds: number;
  created_at: string;
  status: string;
}

interface PredictionOverlayProps {
  channelId?: string;
  channelLogin?: string;
}

const PredictionOverlay = ({ channelId, channelLogin }: PredictionOverlayProps) => {
  const [activePrediction, setActivePrediction] = useState<PredictionData | null>(null);
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null);
  const [betAmount, setBetAmount] = useState<number>(10);
  const [betAmountInput, setBetAmountInput] = useState<string>('10');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [isLocked, setIsLocked] = useState(false);
  const [channelPoints, setChannelPoints] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [hasPlacedBet, setHasPlacedBet] = useState(false);
  const [resolutionState, setResolutionState] = useState<'none' | 'pending' | 'win' | 'loss' | 'refund' | 'announced'>('none');
  const [winningOutcomeId, setWinningOutcomeId] = useState<string | null>(null);

  // Refs to track latest values for use in event listeners (avoids stale closures)
  const hasPlacedBetRef = useRef(hasPlacedBet);
  const selectedOutcomeRef = useRef(selectedOutcome);

  // Keep refs in sync with state
  useEffect(() => {
    hasPlacedBetRef.current = hasPlacedBet;
  }, [hasPlacedBet]);

  useEffect(() => {
    selectedOutcomeRef.current = selectedOutcome;
  }, [selectedOutcome]);

  const { addToast, currentStream } = useAppStore();

  // Get current channel ID from props or from currentStream
  const currentChannelId = channelId || currentStream?.user_id;
  const currentChannelLogin = channelLogin || currentStream?.user_login;

  // Debug log on mount and when channel changes
  useEffect(() => {
    console.log('[Prediction] 🎯 PredictionOverlay mounted/updated');
    console.log('[Prediction] 📺 Watching for channel:', {
      channelId: currentChannelId || 'NOT SET',
      channelLogin: currentChannelLogin || 'NOT SET',
      fromProps: { channelId, channelLogin },
      fromStore: { user_id: currentStream?.user_id, user_login: currentStream?.user_login }
    });
  }, [currentChannelId, currentChannelLogin, channelId, channelLogin, currentStream]);

  // Fetch active prediction on mount/channel change (for late-joiners)
  useEffect(() => {
    const fetchActivePrediction = async () => {
      if (!currentChannelLogin) return;
      
      console.log('[Prediction] 🔍 Checking for active prediction on channel:', currentChannelLogin);
      
      try {
        const result = await invoke<PredictionData | null>('get_active_prediction', {
          channelLogin: currentChannelLogin
        });
        
        if (result) {
          console.log('[Prediction] ✅ Found active prediction on mount:', result);
          
          // Only set if we don't already have this prediction active
          if (!activePrediction || activePrediction.prediction_id !== result.prediction_id) {
            setActivePrediction(result);
            setIsLocked(result.status === 'LOCKED');
            setIsExpanded(true);
            setResolutionState('none');
            setSelectedOutcome(null);
            setHasPlacedBet(false);
            
            // Calculate remaining time if prediction is still ACTIVE
            if (result.status === 'ACTIVE' && result.created_at) {
              const createdAt = new Date(result.created_at).getTime();
              const elapsed = Math.floor((Date.now() - createdAt) / 1000);
              const remaining = Math.max(0, result.prediction_window_seconds - elapsed);
              setTimeRemaining(remaining);
              
              if (remaining === 0) {
                setIsLocked(true);
              }
            } else {
              setTimeRemaining(0);
            }
          }
        } else {
          console.log('[Prediction] No active prediction found on channel');
        }
      } catch (err) {
        console.warn('[Prediction] Failed to fetch active prediction:', err);
      }
    };
    
    // Reset state when channel changes
    setActivePrediction(null);
    setSelectedOutcome(null);
    setHasPlacedBet(false);
    setResolutionState('none');
    setWinningOutcomeId(null);
    setChannelPoints(null);
    
    // Fetch active prediction for the new channel
    fetchActivePrediction();
  }, [currentChannelLogin]);

  // Fetch channel points when prediction becomes active
  const fetchChannelPoints = useCallback(async () => {
    console.log('[Prediction] fetchChannelPoints called with:', { currentChannelLogin, currentChannelId });
    
    // First try by channel login if available
    if (currentChannelLogin) {
      console.log('[Prediction] Fetching channel points by login:', currentChannelLogin);
      
      try {
        const result = await invoke<any>('get_channel_points_for_channel', {
          channelLogin: currentChannelLogin
        });
        
        console.log('[Prediction] Channel points result:', JSON.stringify(result, null, 2));
        
        // Use the correct path: data.user.channel.self.communityPoints.balance
        const balance = result?.data?.user?.channel?.self?.communityPoints?.balance;
        if (typeof balance === 'number') {
          console.log('[Prediction] ✅ Setting channel points to:', balance);
          setChannelPoints(balance);
          return; // Success!
        }
      } catch (err) {
        console.error('[Prediction] Failed to fetch by login:', err);
      }
    }
    
    // Fallback: try by channel ID
    if (currentChannelId) {
      console.log('[Prediction] Trying fallback: get_channel_points_balance with ID:', currentChannelId);
      
      try {
        const result = await invoke<any>('get_channel_points_balance', {
          channelId: currentChannelId
        });
        
        console.log('[Prediction] get_channel_points_balance result:', result);
        
        const balance = result?.balance || result?.points;
        if (typeof balance === 'number') {
          console.log('[Prediction] ✅ Setting channel points from fallback:', balance);
          setChannelPoints(balance);
          return;
        }
      } catch (err) {
        console.error('[Prediction] Fallback also failed:', err);
      }
    }
    
    console.log('[Prediction] Could not fetch channel points with any method');
  }, [currentChannelLogin, currentChannelId]);

  // Listen for channel points updates from backend events
  useEffect(() => {
    // Listen for points spent (includes new balance)
    const unlistenSpent = listen<{ channel_id: string; points: number; balance: number }>('channel-points-spent', (event) => {
      if (currentChannelId && event.payload.channel_id === currentChannelId) {
        console.log('[Prediction] Points spent event - new balance:', event.payload.balance);
        setChannelPoints(event.payload.balance);
      }
    });

    // Listen for points earned (includes new balance)
    const unlistenEarned = listen<{ channel_id: string; points: number; balance: number }>('channel-points-earned', (event) => {
      if (currentChannelId && event.payload.channel_id === currentChannelId) {
        console.log('[Prediction] Points earned event - new balance:', event.payload.balance);
        setChannelPoints(event.payload.balance);
      }
    });

    return () => {
      unlistenSpent.then(fn => fn());
      unlistenEarned.then(fn => fn());
    };
  }, [currentChannelId]);

  // Listen for prediction events
  useEffect(() => {
    console.log('[Prediction] 📡 Setting up event listeners...');
    
    const unlistenCreated = listen<PredictionData>('prediction-created', (event) => {
      const prediction = event.payload;
      console.log('[Prediction] 🎰 Received prediction-created event:', {
        eventChannelId: prediction.channel_id,
        currentChannelId: currentChannelId,
        match: prediction.channel_id === currentChannelId,
        title: prediction.title
      });
      
      // Only show if this prediction is for the current channel we're watching
      if (currentChannelId && prediction.channel_id === currentChannelId) {
        console.log('[Prediction] ✅ Prediction MATCHES current channel! Showing overlay.');
        setActivePrediction(prediction);
        setTimeRemaining(prediction.prediction_window_seconds);
        setIsLocked(false);
        setSelectedOutcome(null);
        setHasPlacedBet(false);
        setIsExpanded(true);
        fetchChannelPoints();
      }
    });

    const unlistenUpdated = listen<PredictionData & { winning_outcome_id?: string }>('prediction-updated', (event) => {
      const prediction = event.payload;
      console.log('[Prediction] 🎰 Received prediction-updated event:', {
        eventChannelId: prediction.channel_id,
        currentChannelId: currentChannelId,
        match: prediction.channel_id === currentChannelId,
        status: prediction.status,
        hasActivePrediction: !!activePrediction
      });
      
      // If we don't have an active prediction but this is for our channel and ACTIVE, initialize it
      // This handles the case where user starts watching after prediction was created
      if (currentChannelId && prediction.channel_id === currentChannelId) {
        if (!activePrediction && (prediction.status === 'ACTIVE' || prediction.status === 'LOCKED')) {
          console.log('[Prediction] ✅ Late-joining prediction! Initializing overlay from update event.');
          setActivePrediction(prediction);
          setTimeRemaining(prediction.prediction_window_seconds || 60);
          setIsLocked(prediction.status === 'LOCKED');
          setSelectedOutcome(null);
          setHasPlacedBet(false);
          setIsExpanded(true);
          setResolutionState('none');
          fetchChannelPoints();
        } else if (activePrediction?.prediction_id === prediction.prediction_id) {
          console.log('[Prediction] Prediction updated:', prediction);
          setActivePrediction(prev => prev ? { ...prev, ...prediction } : null);
          
          if (prediction.status === 'LOCKED') {
            setIsLocked(true);
          }
          
          // Handle resolution states
          if (prediction.status === 'RESOLVE_PENDING') {
            console.log('[Prediction] 🔄 Prediction is being resolved...');
            setResolutionState('pending');
          } else if (prediction.status === 'RESOLVED') {
            console.log('[Prediction] ✅ Prediction RESOLVED! winning_outcome_id:', prediction.winning_outcome_id);
            
            // Use the winning_outcome_id from the event payload
            const winningId = prediction.winning_outcome_id;
            
            if (winningId) {
              const winningOutcome = prediction.outcomes?.find(o => o.id === winningId);
              setWinningOutcomeId(winningId);
              
              // Use refs to get latest values (avoids stale closure issue)
              const userBet = hasPlacedBetRef.current;
              const userSelectedOutcome = selectedOutcomeRef.current;
              
              console.log('[Prediction] 🎯 Resolution check:', {
                winningId,
                userBet,
                userSelectedOutcome,
                didWin: userSelectedOutcome === winningId
              });
              
              // Did user win or lose?
              if (userBet && userSelectedOutcome) {
                if (userSelectedOutcome === winningId) {
                  setResolutionState('win');
                  addToast(`🎉 You WON! "${winningOutcome?.title || 'Unknown'}" was correct!`, 'success');
                } else {
                  setResolutionState('loss');
                  addToast(`😢 You lost. "${winningOutcome?.title || 'Unknown'}" was the winner.`, 'error');
                }
              } else {
                // User didn't bet, just show neutral result announcement
                setResolutionState('announced');
                addToast(`🏆 Prediction ended! Winner: ${winningOutcome?.title || 'Unknown'}`, 'success');
              }
            } else {
              // No winner ID - prediction was cancelled/refunded
              console.log('[Prediction] No winning_outcome_id - prediction was refunded');
              setResolutionState('refund');
              addToast(`🔄 Prediction refunded`, 'info');
            }
            
            // Clear overlay after showing result
            setTimeout(() => {
              setActivePrediction(null);
              setSelectedOutcome(null);
              setHasPlacedBet(false);
              setResolutionState('none');
              setWinningOutcomeId(null);
            }, 4000);
          } else if (prediction.status === 'CANCELED') {
            console.log('[Prediction] ❌ Prediction CANCELED');
            setResolutionState('refund');
            addToast(`🔄 Prediction cancelled - points refunded`, 'info');
            
            setTimeout(() => {
              setActivePrediction(null);
              setSelectedOutcome(null);
              setHasPlacedBet(false);
              setResolutionState('none');
            }, 3000);
          }
        }
      }
    });

    const unlistenLocked = listen<{ channel_id: string; prediction_id: string }>('prediction-locked', (event) => {
      if (currentChannelId && event.payload.channel_id === currentChannelId && activePrediction?.prediction_id === event.payload.prediction_id) {
        console.log('[Prediction] Prediction locked');
        setIsLocked(true);
      }
    });

    const unlistenEnded = listen<{ channel_id: string; prediction_id: string; winning_outcome_id?: string }>('prediction-ended', (event) => {
      if (currentChannelId && event.payload.channel_id === currentChannelId && activePrediction?.prediction_id === event.payload.prediction_id) {
        console.log('[Prediction] Prediction ended, winner:', event.payload.winning_outcome_id);
        
        // Show result briefly before closing
        if (event.payload.winning_outcome_id) {
          const winner = activePrediction?.outcomes.find(o => o.id === event.payload.winning_outcome_id);
          if (winner) {
            addToast(`🏆 Prediction ended! Winner: ${winner.title}`, 'success');
          }
        }
        
        // Close the overlay after a short delay
        setTimeout(() => {
          setActivePrediction(null);
          setSelectedOutcome(null);
          setHasPlacedBet(false);
        }, 2000);
      }
    });

    return () => {
      unlistenCreated.then(fn => fn());
      unlistenUpdated.then(fn => fn());
      unlistenLocked.then(fn => fn());
      unlistenEnded.then(fn => fn());
    };
  }, [currentChannelId, activePrediction?.prediction_id, addToast, fetchChannelPoints]);

  // Countdown timer
  useEffect(() => {
    if (!activePrediction || isLocked || timeRemaining <= 0) return;

    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1) {
          setIsLocked(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [activePrediction, isLocked, timeRemaining]);

  // Handle placing a prediction
  const handlePlacePrediction = async () => {
    if (!activePrediction || !selectedOutcome || isSubmitting || isLocked || hasPlacedBet) return;

    setIsSubmitting(true);

    try {
      await invoke('place_prediction', {
        eventId: activePrediction.prediction_id,
        outcomeId: selectedOutcome,
        points: betAmount,
        channelId: currentChannelId
      });

      const selectedOutcomeTitle = activePrediction.outcomes.find(o => o.id === selectedOutcome)?.title;
      addToast(`🔮 Prediction placed! ${betAmount} points on "${selectedOutcomeTitle}"`, 'success');
      setHasPlacedBet(true);
      
      // Refresh channel points
      fetchChannelPoints();
    } catch (err: any) {
      console.error('[Prediction] Failed to place prediction:', err);
      addToast(`Failed to place prediction: ${err}`, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Format time remaining
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get color class for outcome
  const getOutcomeColor = (color: string, isSelected: boolean) => {
    const baseColors: Record<string, string> = {
      'BLUE': isSelected ? 'bg-blue-500 border-blue-400' : 'bg-blue-500/20 border-blue-500/50 hover:bg-blue-500/30',
      'PINK': isSelected ? 'bg-pink-500 border-pink-400' : 'bg-pink-500/20 border-pink-500/50 hover:bg-pink-500/30',
    };
    return baseColors[color] || (isSelected ? 'bg-purple-500 border-purple-400' : 'bg-purple-500/20 border-purple-500/50 hover:bg-purple-500/30');
  };

  // Calculate percentage for outcome
  const getOutcomePercentage = (outcome: PredictionOutcome) => {
    const totalPoints = activePrediction?.outcomes.reduce((sum, o) => sum + o.total_points, 0) || 0;
    if (totalPoints === 0) return 50; // Default to 50% if no bets yet
    return Math.round((outcome.total_points / totalPoints) * 100);
  };

  // Don't render if no active prediction
  if (!activePrediction) return null;

  return (
    <div className="absolute top-10 left-2 right-2 z-40 transition-all duration-300 ease-in-out">
      {/* Floating overlay with shadow effect */}
      <div className="bg-background rounded-lg border border-border shadow-lg shadow-black/30 overflow-hidden">
        {/* Header - Always visible with channel points */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`w-full p-3 bg-backgroundSecondary hover:bg-backgroundSecondary/80 transition-colors ${isExpanded ? 'border-b border-border' : ''}`}
        >
          <div className={`flex gap-2 ${isExpanded ? 'items-start' : 'items-center'}`}>
            {/* Trophy icon */}
            <div className="p-1.5 bg-purple-500/30 rounded-md flex-shrink-0">
              <Trophy className="w-4 h-4 text-purple-400" />
            </div>
            
            {/* Title - grows to fill space, wraps naturally when expanded, truncates when collapsed */}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold text-textPrimary text-left leading-tight ${
                isExpanded ? '' : 'truncate'
              }`}>
                {activePrediction.title}
              </p>
            </div>
            
            {/* Right side badges - always visible */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {/* Channel Points Badge */}
              {channelPoints !== null && (
                <div className="flex items-center gap-1 px-1.5 py-1 bg-orange-500/20 border border-orange-500/40 rounded-md">
                  <ChannelPointsIcon className="text-orange-400" size={12} />
                  <span className="text-xs font-bold text-orange-400">
                    {channelPoints.toLocaleString()}
                  </span>
                </div>
              )}
              {/* Timer or Locked Badge */}
              {!isLocked ? (
                <span className="text-xs font-mono font-bold text-yellow-400 bg-yellow-500/20 border border-yellow-500/40 px-1.5 py-1 rounded-md">
                  {formatTime(timeRemaining)}
                </span>
              ) : (
                <span className="text-xs font-medium text-red-400 bg-red-500/20 border border-red-500/40 px-1.5 py-1 rounded-md">
                  Locked
                </span>
              )}
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-textSecondary" />
              ) : (
                <ChevronDown className="w-4 h-4 text-textSecondary" />
              )}
            </div>
          </div>
        </button>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="bg-background">
            {/* Outcomes */}
            <div className="p-3 space-y-2">
              {activePrediction.outcomes.map((outcome) => {
                const percentage = getOutcomePercentage(outcome);
                const isSelected = selectedOutcome === outcome.id;
                
                return (
                  <button
                    key={outcome.id}
                    onClick={() => !isLocked && !hasPlacedBet && setSelectedOutcome(outcome.id)}
                    disabled={isLocked || hasPlacedBet}
                    className={`w-full relative p-2.5 rounded-lg border-2 transition-all ${
                      getOutcomeColor(outcome.color, isSelected)
                    } ${(isLocked || hasPlacedBet) ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                  >
                    {/* Background progress bar */}
                    <div 
                      className={`absolute inset-0 rounded-md opacity-30 ${
                        outcome.color === 'BLUE' ? 'bg-blue-500' : outcome.color === 'PINK' ? 'bg-pink-500' : 'bg-purple-500'
                      }`}
                      style={{ width: `${percentage}%` }}
                    />
                    
                    <div className="relative flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {isSelected && (
                          <div className="w-4 h-4 rounded-full bg-white/30 flex items-center justify-center">
                            <div className="w-2.5 h-2.5 rounded-full bg-white" />
                          </div>
                        )}
                        <span className="font-semibold text-white text-sm">{outcome.title}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-white/90">
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {outcome.total_users}
                        </span>
                        <span className="flex items-center gap-1">
                          <ChannelPointsIcon size={12} className="text-white/90" />
                          {outcome.total_points.toLocaleString()}
                        </span>
                        <span className="font-bold text-sm">{percentage}%</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Bet Amount & Action - only when not locked/already bet */}
            {!isLocked && !hasPlacedBet && (
              <div className="px-3 pb-3">
                {/* Bet Input Row */}
                <div className="flex items-center gap-2 p-2 bg-backgroundSecondary rounded-lg border border-border">
                  {/* Number Input */}
                  <input
                    type="text"
                    inputMode="numeric"
                    value={betAmountInput}
                    onChange={(e) => {
                      // Allow only numbers
                      const value = e.target.value.replace(/[^0-9]/g, '');
                      setBetAmountInput(value);
                      // Update betAmount if valid
                      const num = parseInt(value) || 0;
                      if (num > 0) {
                        setBetAmount(num);
                      }
                    }}
                    onBlur={() => {
                      // Validate on blur - ensure minimum of 1 and max of channel points
                      const num = parseInt(betAmountInput) || 1;
                      const maxPoints = channelPoints || 250000;
                      const clamped = Math.min(Math.max(1, num), maxPoints);
                      setBetAmount(clamped);
                      setBetAmountInput(clamped.toString());
                    }}
                    className="w-24 px-2 py-1.5 bg-background border border-border rounded-md text-textPrimary text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500"
                    placeholder="Amount"
                  />
                  
                  {/* Quick Amount Buttons - fewer presets */}
                  <div className="flex gap-1">
                    {[10, 100, 1000].map(amount => (
                      <button
                        key={amount}
                        onClick={() => {
                          setBetAmount(amount);
                          setBetAmountInput(amount.toString());
                        }}
                        className={`px-2 py-1.5 text-xs font-medium rounded transition-colors border ${
                          betAmount === amount 
                            ? 'bg-purple-500/30 border-purple-500/60 text-purple-300'
                            : 'bg-background border-border text-textSecondary hover:bg-backgroundSecondary'
                        }`}
                      >
                        {amount >= 1000 ? `${amount / 1000}k` : amount}
                      </button>
                    ))}
                    {channelPoints && (
                      <button
                        onClick={() => {
                          setBetAmount(channelPoints);
                          setBetAmountInput(channelPoints.toString());
                        }}
                        className="px-2 py-1.5 text-xs font-bold bg-purple-500/30 hover:bg-purple-500/40 border border-purple-500/60 rounded transition-colors text-purple-300"
                      >
                        ALL
                      </button>
                    )}
                  </div>
                  
                  {/* Bet Button - compact */}
                  <button
                    onClick={handlePlacePrediction}
                    disabled={!selectedOutcome || isSubmitting}
                    className={`px-3 py-1.5 rounded text-xs font-bold transition-all whitespace-nowrap ${
                      selectedOutcome && !isSubmitting
                        ? 'bg-purple-500 hover:bg-purple-600 text-white'
                        : 'bg-background border border-border text-textSecondary cursor-not-allowed'
                    }`}
                  >
                    {isSubmitting ? '...' : 'Bet'}
                  </button>
                </div>
              </div>
            )}

            {/* Status indicators */}
            {hasPlacedBet && !isLocked && resolutionState === 'none' && (
              <div className="px-3 pb-3">
                <div className="py-2 px-3 bg-green-500/20 border border-green-500/50 rounded-lg flex items-center justify-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                  <span className="text-green-400 text-sm font-semibold">Bet Placed!</span>
                </div>
              </div>
            )}
            
            {/* Resolution States - Win/Loss/Refund/Pending */}
            {resolutionState === 'pending' && (
              <div className="px-3 pb-3">
                <div className="py-3 px-4 bg-purple-500/20 border border-purple-500/50 rounded-lg flex items-center justify-center gap-2 animate-pulse">
                  <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-purple-400 text-sm font-semibold">
                    Resolving Prediction...
                  </span>
                </div>
              </div>
            )}
            
            {resolutionState === 'win' && (
              <div className="px-3 pb-3">
                <div className="py-4 px-4 bg-gradient-to-r from-green-500/30 to-emerald-500/30 border-2 border-green-400 rounded-lg text-center animate-pulse">
                  <div className="flex justify-center mb-2">
                    <PartyPopper className="w-8 h-8 text-green-400" />
                  </div>
                  <span className="text-green-400 text-lg font-bold">YOU WON!</span>
                  {winningOutcomeId && (
                    <p className="text-green-300/80 text-sm mt-1">
                      {activePrediction.outcomes.find(o => o.id === winningOutcomeId)?.title}
                    </p>
                  )}
                </div>
              </div>
            )}
            
            {resolutionState === 'loss' && (
              <div className="px-3 pb-3">
                <div className="py-4 px-4 bg-gradient-to-r from-red-500/30 to-rose-500/30 border-2 border-red-400 rounded-lg text-center">
                  <div className="flex justify-center mb-2">
                    <XCircle className="w-8 h-8 text-red-400" />
                  </div>
                  <span className="text-red-400 text-lg font-bold">Better Luck Next Time</span>
                  {winningOutcomeId && (
                    <p className="text-red-300/80 text-sm mt-1">
                      Winner: {activePrediction.outcomes.find(o => o.id === winningOutcomeId)?.title}
                    </p>
                  )}
                </div>
              </div>
            )}
            
            {resolutionState === 'refund' && (
              <div className="px-3 pb-3">
                <div className="py-4 px-4 bg-gradient-to-r from-blue-500/30 to-cyan-500/30 border-2 border-blue-400 rounded-lg text-center">
                  <div className="flex justify-center mb-2">
                    <RefreshCw className="w-8 h-8 text-blue-400" />
                  </div>
                  <span className="text-blue-400 text-lg font-bold">Points Refunded</span>
                  <p className="text-blue-300/80 text-sm mt-1">Prediction was cancelled</p>
                </div>
              </div>
            )}
            
            {resolutionState === 'announced' && (
              <div className="px-3 pb-3">
                <div className="py-4 px-4 bg-gradient-to-r from-purple-500/30 to-indigo-500/30 border-2 border-purple-400 rounded-lg text-center">
                  <div className="flex justify-center mb-2">
                    <Trophy className="w-8 h-8 text-purple-400" />
                  </div>
                  <span className="text-purple-400 text-lg font-bold">Prediction Ended</span>
                  {winningOutcomeId && (
                    <p className="text-purple-300/80 text-sm mt-1">
                      Winner: {activePrediction.outcomes.find(o => o.id === winningOutcomeId)?.title}
                    </p>
                  )}
                </div>
              </div>
            )}
            
            {/* Normal Locked State (waiting for results) */}
            {isLocked && resolutionState === 'none' && (
              <div className="px-3 pb-3">
                <div className="py-2 px-3 bg-amber-500/20 border border-amber-500/50 rounded-lg flex items-center justify-center gap-2">
                  <Hourglass className="w-4 h-4 text-amber-400 animate-pulse" />
                  <span className="text-amber-400 text-sm font-semibold">
                    Awaiting Results{hasPlacedBet && ' • Your bet is in!'}
                  </span>
                </div>
                {/* Total stats when locked */}
                <div className="mt-2 flex items-center justify-center gap-4 text-xs text-textSecondary">
                  <span className="flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {activePrediction.outcomes.reduce((sum, o) => sum + o.total_users, 0).toLocaleString()} voters
                  </span>
                  <span className="flex items-center gap-1">
                    <ChannelPointsIcon size={12} className="text-textSecondary" />
                    {activePrediction.outcomes.reduce((sum, o) => sum + o.total_points, 0).toLocaleString()} points
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PredictionOverlay;
