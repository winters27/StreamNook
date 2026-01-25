import { create } from 'zustand';
import { getCosmeticsFromMemoryCache, getCosmeticsWithFallback } from '../services/cosmeticsCache';

/**
 * Represents a user who has chatted in the current channel.
 * Used for @ mention autocomplete suggestions.
 */
export interface ChatUser {
  userId: string;
  username: string;
  displayName: string;
  color: string;
  /** Timestamp of last message - used for sorting by recency */
  lastSeen: number;
  /** 7TV paint data if available (for decorated display) */
  paint?: any;
}

interface ChatUserStore {
  /** Map of userId -> ChatUser for O(1) lookups */
  users: Map<string, ChatUser>;
  /** Map of lowercase username -> userId for fast username lookups */
  usernameToId: Map<string, string>;
  
  /** Add or update a user when they send a message */
  addUser: (user: Omit<ChatUser, 'lastSeen' | 'paint'>) => void;
  
  /** Get a user by username (case-insensitive) */
  getUserByUsername: (username: string) => ChatUser | undefined;
  
  /** Get users matching a search query (prefix match on username/displayName) */
  getMatchingUsers: (query: string, limit?: number) => ChatUser[];
  
  /** Clear all users (call when switching channels) */
  clearUsers: () => void;
}

export const useChatUserStore = create<ChatUserStore>((set, get) => ({
  users: new Map(),
  usernameToId: new Map(),
  
  addUser: (user) => {
    const existingUser = get().users.get(user.userId);
    
    // If user already exists with paint, just update lastSeen and color
    if (existingUser?.paint !== undefined) {
      set((state) => {
        const newUsers = new Map(state.users);
        const newUsernameToId = new Map(state.usernameToId);
        newUsers.set(user.userId, {
          ...existingUser,
          ...user,
          lastSeen: Date.now(),
        });
        newUsernameToId.set(user.username.toLowerCase(), user.userId);
        return { users: newUsers, usernameToId: newUsernameToId };
      });
      return;
    }
    
    // Add user immediately with their base color
    set((state) => {
      const newUsers = new Map(state.users);
      const newUsernameToId = new Map(state.usernameToId);
      newUsers.set(user.userId, {
        ...user,
        lastSeen: Date.now(),
        paint: existingUser?.paint, // Preserve existing paint if any
      });
      newUsernameToId.set(user.username.toLowerCase(), user.userId);
      return { users: newUsers, usernameToId: newUsernameToId };
    });
    
    // Try to fetch 7TV cosmetics in background
    const cachedCosmetics = getCosmeticsFromMemoryCache(user.userId);
    if (cachedCosmetics) {
      // Use cached paint if available
      const selectedPaint = cachedCosmetics.paints?.find((p: any) => p.selected);
      if (selectedPaint) {
        set((state) => {
          const newUsers = new Map(state.users);
          const current = newUsers.get(user.userId);
          if (current) {
            newUsers.set(user.userId, { ...current, paint: selectedPaint });
          }
          return { users: newUsers };
        });
      }
    } else {
      // Fetch from API (non-blocking)
      getCosmeticsWithFallback(user.userId).then((cosmetics) => {
        if (!cosmetics) return;
        const selectedPaint = cosmetics.paints?.find((p: any) => p.selected);
        if (selectedPaint) {
          set((state) => {
            const newUsers = new Map(state.users);
            const current = newUsers.get(user.userId);
            if (current) {
              newUsers.set(user.userId, { ...current, paint: selectedPaint });
            }
            return { users: newUsers };
          });
        }
      }).catch(() => {
        // Silently ignore cosmetics fetch errors
      });
    }
  },
  
  getUserByUsername: (username: string) => {
    const { usernameToId, users } = get();
    const userId = usernameToId.get(username.toLowerCase());
    if (userId) {
      return users.get(userId);
    }
    return undefined;
  },
  
  getMatchingUsers: (query: string, limit = 5) => {
    const { users } = get();
    const queryLower = query.toLowerCase();
    
    // Filter users whose username or displayName starts with query
    const matches: ChatUser[] = [];
    for (const user of users.values()) {
      if (
        user.username.toLowerCase().startsWith(queryLower) ||
        user.displayName.toLowerCase().startsWith(queryLower)
      ) {
        matches.push(user);
      }
    }
    
    // Sort by recency (most recent first)
    matches.sort((a, b) => b.lastSeen - a.lastSeen);
    
    return matches.slice(0, limit);
  },
  
  clearUsers: () => {
    set({ users: new Map(), usernameToId: new Map() });
  },
}));
