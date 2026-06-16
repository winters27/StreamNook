import type { ReactNode } from 'react';

interface SettingsSectionProps {
  label: string;
  description?: string;
  children: ReactNode;
  id?: string;
  bare?: boolean;
}

export const SettingsSection = ({
  label,
  description,
  children,
  id,
  bare = false,
}: SettingsSectionProps) => (
  <section id={id}>
    <div className="px-1 pb-2.5">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-textPrimary">
        {label}
      </h3>
      {description && (
        <p className="mt-1 text-[12px] leading-relaxed text-textMuted">
          {description}
        </p>
      )}
    </div>
    {bare ? (
      <div className="space-y-3">{children}</div>
    ) : (
      <div className="settings-card px-4">{children}</div>
    )}
  </section>
);

interface SettingsRowProps {
  title: string;
  description?: string;
  control?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}

export const SettingsRow = ({
  title,
  description,
  control,
  children,
  disabled = false,
}: SettingsRowProps) => (
  <div
    className={`settings-row -mx-4 px-4 py-3 ${
      disabled ? 'opacity-50 pointer-events-none' : ''
    }`}
  >
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-textPrimary">{title}</div>
        {description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-textSecondary">
            {description}
          </p>
        )}
      </div>
      {control && <div className="flex-shrink-0">{control}</div>}
    </div>
    {children && <div className="mt-3">{children}</div>}
  </div>
);

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedSelectProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
}

export const SegmentedSelect = <T extends string>({
  value,
  options,
  onChange,
}: SegmentedSelectProps<T>) => (
  <div className="flex gap-2">
    {options.map((opt) => {
      const isActive = value === opt.value;
      return (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{ borderRadius: 8 }}
          className={`flex-1 px-4 py-2 text-sm font-medium transition-all ${
            isActive
              ? 'glass-input text-textPrimary'
              : 'glass-button text-textSecondary hover:text-textPrimary'
          }`}
        >
          {opt.label}
        </button>
      );
    })}
  </div>
);
