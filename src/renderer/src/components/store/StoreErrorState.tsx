import {useTranslation} from 'react-i18next';

interface StoreErrorStateProps {
  onRetry: () => void;
}

export default function StoreErrorState({ onRetry }: StoreErrorStateProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="w-12 h-12 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] flex items-center justify-center mb-3">
        <svg className="w-6 h-6 text-[var(--color-danger)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
      </div>
      <p className="text-[13px] text-[var(--color-muted2)] mb-3">{t('store.error')}</p>
      <button onClick={onRetry} className="btn btn-secondary text-[13px]">
        {t('store.retry')}
      </button>
    </div>
  );
}