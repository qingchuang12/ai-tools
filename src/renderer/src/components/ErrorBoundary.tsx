import {Component, type ErrorInfo, type ReactNode} from 'react';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full p-8">
          <div className="w-12 h-12 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-[14px] text-[var(--color-text)] font-medium mb-1">{i18n.t('errorBoundary.title')}</p>
          <p className="text-[12px] text-[var(--color-muted2)] mb-4">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_80%,transparent)] text-white text-[13px] font-medium rounded-lg transition-colors"
          >
            {i18n.t('errorBoundary.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}