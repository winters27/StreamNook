import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    componentName?: string;
    reportToLogService?: boolean;
}

interface State {
    hasError: boolean;
    error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        const componentName = this.props.componentName || 'Component';

        if (this.props.reportToLogService) {
            // Log as error so it gets picked up by logService and sent to Discord
            console.error(`[${componentName}] Critical error caught by boundary:`, error);
            console.error(`[${componentName}] Component stack:`, errorInfo.componentStack);
        } else {
            // Use console.warn instead of console.error to avoid Discord webhook spam for handled errors
            console.warn(`[${componentName}] Error caught and handled by boundary:`, error.message || error.toString());
            console.warn(`[${componentName}] Component stack:`, errorInfo.componentStack);
        }
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="flex items-center justify-center p-4 bg-red-500/10 border border-red-500/20 rounded">
                    <span className="text-red-400 text-sm">
                        {this.props.componentName || 'Component'} failed to load
                    </span>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
