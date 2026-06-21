import { useEffect } from 'react';
import { tickTimeReminders } from '../utils/reminderEngine';

// Headless controller that drives the time-based reminder triggers (interval,
// delay, clock, uptime). It ticks once a second (so seconds-granular durations
// fire promptly) and reads everything it needs from the stores, so it never
// re-renders. Keyword reminders fire from the chat message stream in
// chatConnectionStore and don't depend on this loop.
const ReminderEngine = () => {
  useEffect(() => {
    tickTimeReminders();
    const handle = setInterval(tickTimeReminders, 1000);
    return () => clearInterval(handle);
  }, []);
  return null;
};

export default ReminderEngine;
