import { ReactNode } from 'react';
import { Eye, EyeOff, Key } from '@/lib/lucide-icons';

type ApiKeyField = {
  value: string;
  placeholder: string;
  helperText?: string;
  helperLink?: string;
  helperLinkLabel?: string;
  isVisible: boolean;
  onChange: (value: string) => void;
  onToggleVisibility: () => void;
};

type ModelField = {
  value: string;
  placeholder: string;
  label?: string;
  helperText?: string;
  onChange: (value: string) => void;
};

interface ProviderConfigCardProps {
  title: string;
  description?: string;
  apiKey?: ApiKeyField;
  model?: ModelField;
  children?: ReactNode;
}

export const ProviderConfigCard = ({
  title,
  description,
  apiKey,
  model,
  children,
}: ProviderConfigCardProps) => {
  return (
    <div className="animate-fade-in space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>

      {apiKey && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Key className="h-4 w-4" />
            API Key
          </label>
          <div className="relative">
            <input
              type={apiKey.isVisible ? 'text' : 'password'}
              value={apiKey.value}
              onChange={(e) => apiKey.onChange(e.target.value)}
              placeholder={apiKey.placeholder}
              className="w-full rounded-xl border border-border bg-muted px-4 py-3 pr-12 text-foreground transition-all outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={apiKey.onToggleVisibility}
              className="absolute top-1/2 right-3 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {apiKey.isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {apiKey.helperText && (
            <p className="text-xs text-muted-foreground">
              {apiKey.helperText}{' '}
              {apiKey.helperLink ? (
                <a
                  href={apiKey.helperLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {apiKey.helperLinkLabel ?? 'Learn more'}
                </a>
              ) : null}
            </p>
          )}
        </div>
      )}

      {model && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">
            {model.label ?? 'Model'}
          </label>
          <input
            type="text"
            value={model.value}
            onChange={(e) => model.onChange(e.target.value)}
            placeholder={model.placeholder}
            className="w-full rounded-xl border border-border bg-muted px-4 py-3 font-mono text-sm text-foreground transition-all outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-accent/20"
          />
          {model.helperText ? <p className="text-xs text-muted-foreground">{model.helperText}</p> : null}
        </div>
      )}

      {children}
    </div>
  );
};
