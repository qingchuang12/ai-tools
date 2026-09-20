/**
 * 配置表单组件 - Surge 风格
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';

interface ConfigSchema {
  type: string;
  properties: Record<string, {
    type: string;
    description?: string;
    default?: any;
    enum?: string[];
  }>;
  required: string[];
}

interface ConfigFormProps {
  schema: ConfigSchema;
  initialValues?: Record<string, any>;
  onSubmit: (values: Record<string, any>) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export default function ConfigForm({
  schema,
  initialValues = {},
  onSubmit,
  onCancel,
  isLoading = false,
}: ConfigFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial: Record<string, any> = {};
    Object.entries(schema.properties || {}).forEach(([key, prop]) => {
      initial[key] = initialValues[key] ?? prop.default ?? '';
    });
    setValues(initial);
  }, [schema, initialValues]);

  const handleChange = (key: string, value: any) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const newErrors: Record<string, string> = {};
    schema.required?.forEach((key) => {
      if (!values[key] || (typeof values[key] === 'string' && !values[key].trim())) {
        newErrors[key] = 'Required';
      }
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const filteredValues: Record<string, any> = {};
    Object.entries(values).forEach(([key, value]) => {
      if (value !== '' && value !== undefined && value !== null) {
        filteredValues[key] = value;
      }
    });

    onSubmit(filteredValues);
  };

  const properties = Object.entries(schema.properties || {});

  if (properties.length === 0) {
    return (
      <div className="flex flex-col items-center text-center px-5 py-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
        {/* 「无需配置」是就绪态而非警告，用绿色对勾徽标传达「不需要任何操作，直接安装即可」 */}
        <div className="w-11 h-11 rounded-full bg-success/10 flex items-center justify-center mb-3">
          <svg className="w-6 h-6 text-[var(--color-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"
               strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
          </svg>
        </div>

        <p className="text-[13px] font-medium text-[var(--color-text)] leading-relaxed">
          {t('detail.noConfigRequired')}
        </p>

        <div className="flex justify-center gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-secondary cursor-pointer"
          >
            {t('detail.cancel')}
          </button>
          <button
            onClick={() => onSubmit({})}
            disabled={isLoading}
            className="btn btn-primary cursor-pointer disabled:opacity-50"
          >
            {isLoading ? t('common.loading') : t('detail.save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {properties.map(([key, prop]) => {
        const isRequired = schema.required?.includes(key);
        const hasError = !!errors[key];

        return (
          <div key={key}>
            <label className="block mb-1">
              <span className="text-[12px] font-medium text-[var(--color-text)]">
                {key}
              </span>
              {isRequired ? (
                <span className="ms-1 text-[12px] text-[#ff3b30]">*</span>
              ) : (
                <span className="ms-1 text-[12px] text-[var(--color-muted)]">({t('detail.optional')})</span>
              )}
            </label>
            
            {prop.description && (
              <p className="text-[12px] text-[var(--color-muted)] mb-1.5">{prop.description}</p>
            )}

            {prop.enum ? (
              <select
                value={values[key] || ''}
                onChange={(e) => handleChange(key, e.target.value)}
                className={`
                  w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border text-[13px] text-[var(--color-text)]
                  transition-colors
                  ${hasError 
                    ? 'border-[#ff3b30]' 
                    : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
                  }
                `}
              >
                <option value="">Select...</option>
                {prop.enum.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            ) : prop.type === 'boolean' ? (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={values[key] || false}
                  onChange={(e) => handleChange(key, e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-accent)] focus:ring-[#0a84ff]/50"
                />
                <span className="text-[12px] text-[var(--color-muted2)]">Enable</span>
              </label>
            ) : prop.type === 'number' || prop.type === 'integer' ? (
              <input
                type="number"
                value={values[key] || ''}
                onChange={(e) => handleChange(key, e.target.value ? Number(e.target.value) : '')}
                placeholder={prop.default?.toString()}
                className={`
                  w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border text-[13px] text-[var(--color-text)]
                  placeholder:text-[var(--color-muted)] transition-colors
                  ${hasError 
                    ? 'border-[#ff3b30]' 
                    : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
                  }
                `}
              />
            ) : (
              <input
                type={key.toLowerCase().includes('password') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') || key.toLowerCase().includes('key') ? 'password' : 'text'}
                value={values[key] || ''}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={prop.default?.toString() || `Enter ${key}...`}
                className={`
                  w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border text-[13px] text-[var(--color-text)]
                  placeholder:text-[var(--color-muted)] transition-colors
                  ${hasError 
                    ? 'border-[#ff3b30]' 
                    : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
                  }
                `}
              />
            )}

            {hasError && (
              <p className="mt-1 text-[12px] text-[#ff3b30]">{errors[key]}</p>
            )}
          </div>
        );
      })}

      <div className="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-secondary cursor-pointer"
        >
          {t('detail.cancel')}
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="btn btn-primary cursor-pointer disabled:opacity-50"
        >
          {isLoading ? t('common.loading') : t('detail.save')}
        </button>
      </div>
    </form>
  );
}
