// Sets tab: list a channel's emote sets, switch the active set, and create /
// rename / resize / delete sets. Set management is gated on the emote-set admin
// permission (your own channel always qualifies); plain editors can still add
// and remove emotes via the Emotes tab.
import { useState } from 'react';
import { Plus, Check, X, Trash2, Pencil, Star, Loader2, Layers } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { Tooltip } from '../ui/Tooltip';
import {
  createSet, renameSet, setSetCapacity, deleteSet, setActiveSet,
  SevenTVSessionExpired, type ChannelSet, type EditableChannel,
} from '../../services/seventvEditorService';

interface Props {
  channel: EditableChannel;
  sets: ChannelSet[] | null;
  onMutated: () => void;
  onOpenSet: (id: string) => void;
}

export default function SetsPanel({ channel, sets, onMutated, onOpenSet }: Props) {
  const addToast = useAppStore((s) => s.addToast);
  const canAdmin = channel.perms.adminEmoteSets;
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onMutated();
    } catch (e) {
      addToast(
        e instanceof SevenTVSessionExpired
          ? 'Your 7TV session expired. Reconnect your 7TV account.'
          : e instanceof Error ? e.message : 'Action failed',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto custom-scrollbar px-4 py-3">
      {canAdmin && (
        <div className="mb-3">
          {creating ? (
            <div className="flex items-center gap-2 max-w-md">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) {
                    guard(async () => {
                      await createSet(newName.trim(), channel.seventvUserId);
                      setCreating(false);
                      setNewName('');
                    });
                  } else if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
                placeholder="New set name"
                className="flex-1 px-3 py-1.5 rounded-lg bg-glass text-sm text-textPrimary placeholder:text-textMuted outline-none focus:ring-1 focus:ring-accent/40"
              />
              <button
                disabled={!newName.trim() || busy}
                onClick={() =>
                  guard(async () => {
                    await createSet(newName.trim(), channel.seventvUserId);
                    setCreating(false);
                    setNewName('');
                  })
                }
                className="glass-button px-3 py-1.5 rounded text-sm text-textPrimary disabled:opacity-50"
              >
                Create
              </button>
              <button
                onClick={() => { setCreating(false); setNewName(''); }}
                className="p-1.5 text-textSecondary hover:text-textPrimary rounded"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="glass-button px-3 py-1.5 rounded text-sm text-textPrimary flex items-center gap-1.5"
            >
              <Plus size={15} /> New set
            </button>
          )}
        </div>
      )}

      {sets === null ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={20} className="animate-spin text-textSecondary" />
        </div>
      ) : sets.length === 0 ? (
        <p className="text-sm text-textMuted text-center py-10">No emote sets on this channel yet.</p>
      ) : (
        <div className="space-y-2">
          {sets.map((s) => (
            <SetRow
              key={s.id}
              set={s}
              canAdmin={canAdmin}
              busy={busy}
              onOpen={() => onOpenSet(s.id)}
              onSetActive={() => guard(() => setActiveSet(channel.seventvUserId, s.id))}
              onRename={(name) => guard(() => renameSet(s.id, name))}
              onCapacity={(cap) => guard(() => setSetCapacity(s.id, cap))}
              onDelete={() => guard(() => deleteSet(s.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SetRow({
  set, canAdmin, busy, onOpen, onSetActive, onRename, onCapacity, onDelete,
}: {
  set: ChannelSet;
  canAdmin: boolean;
  busy: boolean;
  onOpen: () => void;
  onSetActive: () => void;
  onRename: (name: string) => void;
  onCapacity: (cap: number) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(set.name);
  const [editingCap, setEditingCap] = useState(false);
  const [cap, setCap] = useState(String(set.capacity ?? ''));
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="glass-panel rounded-lg p-3 flex items-center gap-3">
      <Layers size={16} className="text-textMuted shrink-0" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onRename(name); setRenaming(false); }
              else if (e.key === 'Escape') { setName(set.name); setRenaming(false); }
            }}
            onBlur={() => { setName(set.name); setRenaming(false); }}
            className="w-full max-w-xs px-2 py-1 rounded bg-glass text-sm text-textPrimary outline-none focus:ring-1 focus:ring-accent/40"
          />
        ) : (
          <button onClick={onOpen} className="text-left">
            <span className="text-sm text-textPrimary hover:underline">{set.name}</span>
          </button>
        )}
        <div className="text-[11px] text-textMuted flex items-center gap-2 mt-0.5">
          {set.kind !== 'NORMAL' && <span className="lowercase">{set.kind}</span>}
          {editingCap ? (
            <input
              autoFocus
              type="number"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = parseInt(cap, 10);
                  if (!Number.isNaN(n)) onCapacity(n);
                  setEditingCap(false);
                } else if (e.key === 'Escape') {
                  setCap(String(set.capacity ?? ''));
                  setEditingCap(false);
                }
              }}
              onBlur={() => { setCap(String(set.capacity ?? '')); setEditingCap(false); }}
              className="w-20 px-1 py-0.5 rounded bg-glass text-[11px] text-textPrimary outline-none"
            />
          ) : (
            <span>capacity {set.capacity ?? '—'}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {set.isActive ? (
          <span className="text-[11px] text-emerald-400 flex items-center gap-1 px-2">
            <Star size={12} className="fill-emerald-400" /> active
          </span>
        ) : (
          canAdmin && (
            <Tooltip content="Set as active set for this channel" side="top" delay={200}>
              <button
                onClick={onSetActive}
                disabled={busy}
                className="px-2 py-1 rounded text-[11px] text-textSecondary hover:text-textPrimary hover:bg-glass disabled:opacity-50 flex items-center gap-1"
              >
                <Star size={12} /> Set active
              </button>
            </Tooltip>
          )
        )}
        {canAdmin && (
          <>
            <Tooltip content="Edit capacity" side="top" delay={200}>
              <button onClick={() => setEditingCap(true)} className="p-1.5 rounded text-textSecondary hover:text-textPrimary hover:bg-glass">
                <span className="text-[11px]">#</span>
              </button>
            </Tooltip>
            <Tooltip content="Rename set" side="top" delay={200}>
              <button onClick={() => { setName(set.name); setRenaming(true); }} className="p-1.5 rounded text-textSecondary hover:text-textPrimary hover:bg-glass">
                <Pencil size={13} />
              </button>
            </Tooltip>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <Tooltip content="Confirm delete set" side="top" delay={150}>
                  <button onClick={onDelete} disabled={busy} className="p-1.5 rounded text-red-400 hover:bg-glass">
                    <Check size={13} />
                  </button>
                </Tooltip>
                <button onClick={() => setConfirmDelete(false)} className="p-1.5 rounded text-textSecondary hover:bg-glass">
                  <X size={13} />
                </button>
              </div>
            ) : (
              <Tooltip content="Delete set" side="top" delay={200}>
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={set.isActive}
                  className="p-1.5 rounded text-textSecondary hover:text-red-400 hover:bg-glass disabled:opacity-30"
                >
                  <Trash2 size={13} />
                </button>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}
