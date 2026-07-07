import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { BarChart3, Users, ChevronDown, ChevronUp, CheckCircle2, Trophy } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';

interface PollChoice {
  id: string;
  title: string;
  total_votes: number;
  total_voters: number;
}

interface PollData {
  channel_id: string;
  poll_id: string;
  title: string;
  status: string; // ACTIVE | COMPLETED
  duration_seconds: number;
  remaining_ms: number;
  total_voters: number;
  total_votes: number;
  started_at: string;
  channel_points_voting: boolean;
  channel_points_cost: number;
  choices: PollChoice[];
}

interface PollOverlayProps {
  channelId?: string;
  channelLogin?: string;
  isHypeTrainActive?: boolean;
}

const PollOverlay = ({ channelId, isHypeTrainActive = false }: PollOverlayProps) => {
  const [activePoll, setActivePoll] = useState<PollData | null>(null);
  const [votedChoiceId, setVotedChoiceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number>(0); // seconds
  const [isExpanded, setIsExpanded] = useState(true);

  // Ref mirrors votedChoiceId so the completion listener sees the latest value
  // without re-subscribing (same pattern as PredictionOverlay).
  const votedChoiceIdRef = useRef(votedChoiceId);
  useEffect(() => { votedChoiceIdRef.current = votedChoiceId; }, [votedChoiceId]);

  const { addToast, currentStream } = useAppStore();

  const currentChannelId = channelId || currentStream?.user_id;

  const isClosed = activePoll?.status === 'COMPLETED';
  const isLocked = isClosed || timeRemaining <= 0 || votedChoiceId !== null;

  // Reset when the watched channel changes.
  useEffect(() => {
    setActivePoll(null);
    setVotedChoiceId(null);
    setTimeRemaining(0);
  }, [currentChannelId]);

  // Listen for poll lifecycle events from the PubSub backend.
  useEffect(() => {
    const applyPoll = (poll: PollData) => {
      setActivePoll(poll);
      setTimeRemaining(Math.max(0, Math.round((poll.remaining_ms || 0) / 1000)));
      setIsExpanded(true);
    };

    const unlistenCreated = listen<PollData>('poll-created', (event) => {
      const poll = event.payload;
      if (currentChannelId && poll.channel_id === currentChannelId) {
        Logger.debug('[Poll] Created:', poll.title);
        setVotedChoiceId(null);
        applyPoll(poll);
      }
    });

    const unlistenUpdated = listen<PollData>('poll-updated', (event) => {
      const poll = event.payload;
      if (!currentChannelId || poll.channel_id !== currentChannelId) return;

      // Late-join: first time we hear about an in-progress poll is an update.
      setActivePoll(prev => {
        if (!prev || prev.poll_id !== poll.poll_id) {
          Logger.debug('[Poll] Late-join via update:', poll.title);
          return poll;
        }
        // Merge live counts while keeping our local state.
        return { ...prev, ...poll };
      });
      setTimeRemaining(Math.max(0, Math.round((poll.remaining_ms || 0) / 1000)));
      setIsExpanded(true);
    });

    const unlistenCompleted = listen<PollData>('poll-completed', (event) => {
      const poll = event.payload;
      if (!currentChannelId || poll.channel_id !== currentChannelId) return;

      Logger.debug('[Poll] Completed:', poll.title);
      setActivePoll(prev => (prev ? { ...prev, ...poll, status: 'COMPLETED' } : poll));
      setTimeRemaining(0);

      // Announce the winner, then clear the overlay after a beat.
      const winner = [...poll.choices].sort((a, b) => b.total_votes - a.total_votes)[0];
      if (winner && poll.total_votes > 0) {
        const userWon = votedChoiceIdRef.current === winner.id;
        addToast(
          userWon
            ? `Poll ended. Your pick "${winner.title}" won!`
            : `Poll ended. Winner: "${winner.title}"`,
          'success'
        );
      }

      setTimeout(() => {
        setActivePoll(null);
        setVotedChoiceId(null);
      }, 5000);
    });

    return () => {
      // A teardown unlisten can throw if the registry entry is already gone;
      // swallow it so it doesn't surface as an uncaught rejection.
      unlistenCreated.then(fn => fn()).catch(() => {});
      unlistenUpdated.then(fn => fn()).catch(() => {});
      unlistenCompleted.then(fn => fn()).catch(() => {});
    };
  }, [currentChannelId, addToast]);

  // Countdown timer.
  useEffect(() => {
    if (!activePoll || isClosed || timeRemaining <= 0) return;
    const timer = setInterval(() => {
      setTimeRemaining(prev => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [activePoll, isClosed, timeRemaining]);

  const handleVote = async (choiceId: string) => {
    if (!activePoll || isSubmitting || isLocked) return;

    setIsSubmitting(true);
    // Optimistic: lock in the choice immediately; live counts arrive via PubSub.
    setVotedChoiceId(choiceId);

    try {
      await invoke('vote_on_poll', {
        pollId: activePoll.poll_id,
        choiceId,
        channelId: currentChannelId,
      });
      const title = activePoll.choices.find(c => c.id === choiceId)?.title;
      addToast(`Vote cast for "${title}"`, 'success');
    } catch (err: any) {
      Logger.error('[Poll] Vote failed:', err);
      addToast(`Failed to vote: ${err}`, 'error');
      setVotedChoiceId(null); // roll back so the user can retry
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const totalVotes = activePoll?.choices.reduce((sum, c) => sum + c.total_votes, 0) || 0;
  const getPercentage = (choice: PollChoice) =>
    totalVotes === 0 ? 0 : Math.round((choice.total_votes / totalVotes) * 100);

  // Winner (only meaningful once closed) for result highlighting.
  const winningChoiceId = isClosed && totalVotes > 0
    ? [...(activePoll?.choices || [])].sort((a, b) => b.total_votes - a.total_votes)[0]?.id
    : null;

  if (!activePoll) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      className={`absolute ${isHypeTrainActive ? 'top-16' : 'top-10'} left-2 right-2 z-40 transition-[top] duration-300 ease-in-out`}
    >
      <div className="bg-background rounded-lg border border-border shadow-lg shadow-black/30 overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`w-full p-3 bg-backgroundSecondary hover:bg-backgroundSecondary/80 transition-colors ${isExpanded ? 'border-b border-border' : ''}`}
        >
          <div className={`flex gap-2 ${isExpanded ? 'items-start' : 'items-center'}`}>
            <div className="p-1.5 bg-purple-500/30 rounded-md flex-shrink-0">
              <BarChart3 className="w-4 h-4 text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold text-textPrimary text-left leading-tight ${isExpanded ? '' : 'truncate'}`}>
                {activePoll.title}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {isClosed ? (
                <span className="text-xs font-medium text-purple-400 bg-purple-500/20 border border-purple-500/40 px-1.5 py-1 rounded-md">
                  Final
                </span>
              ) : timeRemaining > 0 ? (
                <span className="text-xs font-mono font-bold text-yellow-400 bg-yellow-500/20 border border-yellow-500/40 px-1.5 py-1 rounded-md">
                  {formatTime(timeRemaining)}
                </span>
              ) : (
                <span className="text-xs font-medium text-red-400 bg-red-500/20 border border-red-500/40 px-1.5 py-1 rounded-md">
                  Closed
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

        {/* Expanded content */}
        {isExpanded && (
          <div className="bg-background">
            <div className="p-3 space-y-2">
              {activePoll.choices.map((choice) => {
                const percentage = getPercentage(choice);
                const isVoted = votedChoiceId === choice.id;
                const isWinner = winningChoiceId === choice.id;
                const clickable = !isLocked;

                return (
                  <button
                    key={choice.id}
                    onClick={() => clickable && handleVote(choice.id)}
                    disabled={!clickable}
                    className={`w-full relative p-2.5 rounded-lg border-2 transition-all overflow-hidden ${
                      isWinner
                        ? 'bg-purple-500/20 border-purple-400'
                        : isVoted
                          ? 'bg-purple-500/20 border-purple-400/70'
                          : 'bg-backgroundSecondary border-border ' + (clickable ? 'hover:bg-purple-500/10 hover:border-purple-500/40 cursor-pointer' : 'cursor-default')
                    }`}
                  >
                    {/* Vote-share bar */}
                    <div
                      className={`absolute inset-y-0 left-0 rounded-md opacity-25 transition-[width] duration-500 ${isWinner ? 'bg-purple-500' : 'bg-purple-500/70'}`}
                      style={{ width: `${percentage}%` }}
                    />
                    <div className="relative flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {isWinner && <Trophy className="w-3.5 h-3.5 text-purple-300 flex-shrink-0" />}
                        {isVoted && !isWinner && <CheckCircle2 className="w-3.5 h-3.5 text-purple-300 flex-shrink-0" />}
                        <span className="font-semibold text-textPrimary text-sm truncate">{choice.title}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-textSecondary flex-shrink-0">
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {choice.total_votes.toLocaleString()}
                        </span>
                        <span className="font-bold text-sm text-textPrimary">{percentage}%</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Footer status line */}
            <div className="px-3 pb-3">
              {votedChoiceId && !isClosed && (
                <div className="py-2 px-3 bg-purple-500/15 border border-purple-500/40 rounded-lg flex items-center justify-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-purple-400" />
                  <span className="text-purple-400 text-sm font-semibold">Vote counted</span>
                </div>
              )}
              {!votedChoiceId && !isLocked && (
                <p className="text-center text-xs text-textSecondary">
                  Tap a choice to vote
                  {activePoll.channel_points_voting ? ' (free votes only)' : ''}
                </p>
              )}
              <div className="mt-2 flex items-center justify-center gap-1 text-xs text-textSecondary">
                <Users className="w-3 h-3" />
                {activePoll.total_voters.toLocaleString()} {activePoll.total_voters === 1 ? 'voter' : 'voters'}
              </div>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default PollOverlay;
