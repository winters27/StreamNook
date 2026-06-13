import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PanelChannel, PanelField, PanelSchema, PanelValues } from '../../types/plugins';
import { Logger } from '../../utils/logger';
import { Toggle, ChipList, FolderPicker, Slider, Select, ChannelList } from './uiKit';

interface Props {
  pluginId: string;
}

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
  const blockTypes = ['string_list', 'channel_list', 'slider', 'folder'];

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
          <Select
            value={String(valueOf(field) ?? '')}
            options={field.options ?? []}
            onChange={(v) => commit(field.key, v)}
          />
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
          <ChannelList
            value={Array.isArray(valueOf(field)) ? (valueOf(field) as unknown as PanelChannel[]) : []}
            onChange={(next) => commit(field.key, next)}
          />
        );
      case 'slider':
        return (
          <Slider
            value={Number(valueOf(field) ?? field.min ?? 0)}
            min={field.min}
            max={field.max}
            step={field.step}
            unit={field.unit}
            displayDivisor={field.display_divisor}
            onChange={(n) => commit(field.key, n)}
          />
        );
      case 'folder':
        return (
          <FolderPicker
            value={typeof valueOf(field) === 'string' ? (valueOf(field) as string) : ''}
            placeholder={field.placeholder}
            onChange={(next) => commit(field.key, next)}
          />
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
