import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, X } from 'lucide-react';
import { PanelChannel, PanelField, PanelSchema, PanelValues } from '../../types/plugins';
import { Logger } from '../../utils/logger';
import PanelChannelList from './PanelChannelList';

interface Props {
  pluginId: string;
}

const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
  <button
    type="button"
    onClick={onChange}
    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
      enabled ? 'bg-accent' : 'bg-gray-600'
    }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        enabled ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

// Add-and-remove chip rows for a list of strings (not a textarea).
const ChipList = ({
  items,
  placeholder,
  onChange,
}: {
  items: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) => {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setInput('');
  };
  return (
    <div className="mt-2">
      <div className="mb-2 space-y-1.5">
        {items.length > 0 ? (
          items.map((item, i) => (
            <div
              key={item}
              className="group flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-white/5 font-mono text-[11px] text-textSecondary">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-textPrimary">{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((x) => x !== item))}
                className="rounded p-1 text-textMuted opacity-0 transition-all hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-2.5 text-center text-[12px] italic text-textSecondary">
            None added.
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          placeholder={placeholder ?? 'Add...'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className="glass-input flex-1 rounded-md px-3 py-1.5 text-[13px] text-textPrimary"
        />
        <button
          type="button"
          onClick={add}
          disabled={!input.trim()}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-[13px] text-textSecondary transition-colors hover:bg-white/10 hover:text-textPrimary disabled:opacity-50"
        >
          <Plus size={14} />
          Add
        </button>
      </div>
    </div>
  );
};

const Slider = ({ field, value, onChange }: { field: PanelField; value: number; onChange: (n: number) => void }) => {
  const divisor = field.display_divisor ?? 1;
  const shown = divisor > 1 ? Math.round(value / divisor) : value;
  return (
    <div className="mt-1">
      <div className="mb-1 text-[12px] text-textSecondary">
        {shown}
        {field.unit ? ` ${field.unit}` : ''}
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-accent"
      />
    </div>
  );
};

/**
 * Renders a plugin's settings panel from the generic field vocabulary it
 * declared (docs/plugins/PROTOCOL.md, register_panel). The host draws the form
 * from generic field types; it has no knowledge of which plugin or feature it
 * is. Value changes persist on the host and reach the plugin as on_panel_change.
 */
const PluginPanelRenderer = ({ pluginId }: Props) => {
  const [schema, setSchema] = useState<PanelSchema | null>(null);
  const [values, setValues] = useState<PanelValues>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    invoke<{ schema: PanelSchema; values: PanelValues } | null>('plugins_get_panel', { pluginId })
      .then((panel) => {
        if (!mounted) return;
        if (panel) {
          setSchema(panel.schema);
          setValues(panel.values ?? {});
        }
        setLoaded(true);
      })
      .catch((err) => {
        Logger.error('[Plugins] panel load failed:', err);
        if (mounted) setLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, [pluginId]);

  const commit = useCallback(
    (key: string, val: unknown) => {
      setValues((prev) => {
        const next = { ...prev, [key]: val };
        invoke('plugins_set_panel_values', { pluginId, values: next }).catch((err) =>
          Logger.error('[Plugins] panel save failed:', err)
        );
        return next as PanelValues;
      });
    },
    [pluginId]
  );

  if (!loaded) return null;
  if (!schema) {
    return (
      <p className="px-1 py-2 text-[12px] text-textSecondary">
        This plugin has not registered its settings panel yet. Panels appear after the plugin starts.
      </p>
    );
  }

  const valueOf = (field: PanelField) => values[field.key] ?? field.default;
  const blockTypes = ['string_list', 'channel_list', 'slider'];

  const inlineControl = (field: PanelField) => {
    switch (field.type) {
      case 'toggle':
        return <Toggle enabled={Boolean(valueOf(field))} onChange={() => commit(field.key, !valueOf(field))} />;
      case 'number':
        return (
          <input
            type="number"
            className="glass-input w-24 rounded-md px-2 py-1 text-[13px] text-textPrimary"
            value={Number(valueOf(field) ?? 0)}
            min={field.min}
            max={field.max}
            onChange={(e) => commit(field.key, Number(e.target.value))}
          />
        );
      case 'text':
        return (
          <input
            type="text"
            className="glass-input w-48 rounded-md px-2 py-1 text-[13px] text-textPrimary"
            value={String(valueOf(field) ?? '')}
            placeholder={field.placeholder}
            onChange={(e) => commit(field.key, e.target.value)}
          />
        );
      case 'select':
        return (
          <select
            className="glass-input rounded-md bg-transparent px-2 py-1 text-[13px] text-textPrimary"
            value={String(valueOf(field) ?? '')}
            onChange={(e) => commit(field.key, e.target.value)}
          >
            {(field.options ?? []).map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-zinc-900">
                {opt.label}
              </option>
            ))}
          </select>
        );
      default:
        return null;
    }
  };

  const blockControl = (field: PanelField) => {
    switch (field.type) {
      case 'string_list':
        return (
          <ChipList
            items={Array.isArray(valueOf(field)) ? (valueOf(field) as string[]) : []}
            placeholder={field.placeholder}
            onChange={(next) => commit(field.key, next)}
          />
        );
      case 'channel_list':
        return (
          <PanelChannelList
            value={Array.isArray(valueOf(field)) ? (valueOf(field) as unknown as PanelChannel[]) : []}
            onChange={(next) => commit(field.key, next)}
          />
        );
      case 'slider':
        return (
          <Slider field={field} value={Number(valueOf(field) ?? field.min ?? 0)} onChange={(n) => commit(field.key, n)} />
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-3">
      {schema.sections.map((section, i) => (
        <div key={section.label ?? i} className="rounded-lg bg-white/[0.02] py-1.5">
          {section.label && (
            <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-textMuted">
              {section.label}
            </div>
          )}
          {section.description && (
            <p className="px-3 pb-1 text-[12px] leading-relaxed text-textSecondary">{section.description}</p>
          )}
          {section.fields.map((field) => {
            const isBlock = blockTypes.includes(field.type);
            return (
              <div key={field.key} className="settings-row px-3 py-2.5">
                {isBlock ? (
                  <div>
                    <div className="text-[13px] font-medium text-textPrimary">{field.label}</div>
                    {field.description && (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-textSecondary">{field.description}</p>
                    )}
                    {blockControl(field)}
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-textPrimary">{field.label}</div>
                      {field.description && (
                        <p className="mt-0.5 text-[12px] leading-relaxed text-textSecondary">{field.description}</p>
                      )}
                    </div>
                    <div className="flex-shrink-0">{inlineControl(field)}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default PluginPanelRenderer;
