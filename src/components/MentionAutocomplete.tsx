import React, { useEffect, useRef, useMemo } from 'react';
import { ChatUser } from '../stores/chatUserStore';
import { computePaintStyle } from '../services/seventvService';

interface MentionAutocompleteProps {
  /** List of matching users to display */
  users: ChatUser[];
  /** Currently selected index */
  selectedIndex: number;
  /** Callback when a user is selected */
  onSelect: (user: ChatUser) => void;
  /** Callback to change selected index */
  onSelectedIndexChange: (index: number) => void;
}

/**
 * Individual user item with paint styling
 */
const MentionUserItem: React.FC<{
  user: ChatUser;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  itemRef: (el: HTMLButtonElement | null) => void;
}> = ({ user, isSelected, onSelect, onHover, itemRef }) => {
  // Compute paint style for the user's display name
  const nameStyle = useMemo(() => {
    if (user.paint) {
      return computePaintStyle(user.paint, user.color);
    }
    return { color: user.color || '#9147FF' };
  }, [user.paint, user.color]);

  return (
    <button
      ref={itemRef}
      className={`w-full px-3 py-2 flex items-center gap-2 text-left transition-colors ${
        isSelected
          ? 'bg-accent/20'
          : 'hover:bg-white/5'
      }`}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      {/* Color indicator dot */}
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: user.color || '#9147FF' }}
      />
      {/* Display name with paint styling */}
      <span className="flex-1 min-w-0 truncate">
        <span 
          className="font-semibold"
          style={nameStyle}
        >
          {user.displayName}
        </span>
        {user.displayName.toLowerCase() !== user.username.toLowerCase() && (
          <span className="text-textSecondary text-xs ml-1 opacity-70">
            (@{user.username})
          </span>
        )}
      </span>
    </button>
  );
};

/**
 * Floating autocomplete popup for @ mentions.
 * Shows matching users with keyboard navigation support.
 */
const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({
  users,
  selectedIndex,
  onSelect,
  onSelectedIndexChange,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem && listRef.current) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Reset refs when users change
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, users.length);
  }, [users.length]);

  if (users.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute z-50 w-full max-h-[220px] overflow-y-auto rounded-lg border border-borderSubtle shadow-2xl"
      style={{
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: '8px',
        // Solid dark background with slight transparency for depth
        backgroundColor: 'rgba(18, 18, 20, 0.98)',
        backdropFilter: 'blur(12px)',
      }}
      ref={listRef}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-borderSubtle">
        <span className="text-[10px] font-medium text-textSecondary uppercase tracking-wide">
          Mention User
        </span>
      </div>
      {/* User list */}
      <div className="py-1">
        {users.map((user, index) => (
          <MentionUserItem
            key={user.userId}
            user={user}
            isSelected={index === selectedIndex}
            onSelect={() => onSelect(user)}
            onHover={() => onSelectedIndexChange(index)}
            itemRef={(el) => { itemRefs.current[index] = el; }}
          />
        ))}
      </div>
    </div>
  );
};

export default MentionAutocomplete;
