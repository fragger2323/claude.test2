import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { SkeletonRows, Toaster } from './components/ui';
import { api } from './lib/api';
import { AuthPage } from './pages/Auth';

const Today = lazy(() => import('./pages/Today'));
const NewSearch = lazy(() => import('./pages/NewSearch'));
const JobResults = lazy(() => import('./pages/JobResults'));
const Leads = lazy(() => import('./pages/Leads'));
const LeadDetail = lazy(() => import('./pages/LeadDetail'));
const Crm = lazy(() => import('./pages/Crm'));
const Campaigns = lazy(() => import('./pages/Campaigns'));
const SavedSearches = lazy(() => import('./pages/SavedSearches'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Learning = lazy(() => import('./pages/Learning'));
const Business = lazy(() => import('./pages/Business'));
const Settings = lazy(() => import('./pages/Settings'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Import = lazy(() => import('./pages/Import'));

interface AuthStatus {
  needsSetup: boolean;
  authenticated: boolean;
  user: { id: string; email: string; name: string | null } | null;
  setupTokenRequired: boolean;
}

export function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api<AuthStatus>('/api/auth/status'), staleTime: 60_000 });
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('aios:unauthorized', onUnauthorized);
    return () => window.removeEventListener('aios:unauthorized', onUnauthorized);
  }, [qc]);

  if (auth.isLoading) {
    return (
      <div className="mx-auto max-w-md p-10">
        <SkeletonRows rows={3} />
      </div>
    );
  }
  if (!auth.data?.authenticated || !auth.data.user) {
    return (
      <>
        <AuthPage mode={auth.data?.needsSetup ? 'setup' : 'login'} setupTokenRequired={!!auth.data?.setupTokenRequired} onDone={() => qc.invalidateQueries()} />
        <Toaster />
      </>
    );
  }
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    qc.clear();
    await qc.invalidateQueries({ queryKey: ['auth'] });
  };
  return (
    <Layout user={auth.data.user} onLogout={logout}>
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/today" element={<Today />} />
          <Route path="/search" element={<NewSearch />} />
          <Route path="/jobs/:id" element={<JobResults />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/crm" element={<Crm />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<Campaigns />} />
          <Route path="/saved" element={<SavedSearches />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/learning" element={<Learning />} />
          <Route path="/business" element={<Business />} />
          <Route path="/import" element={<Import />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
    </Layout>
  );
}
