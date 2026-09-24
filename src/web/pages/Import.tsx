import { useMutation } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { Button, Checkbox, Field, Input, PageHeader, Panel, toast } from '../components/ui';

export default function Import() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [niche, setNiche] = useState('');
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('');
  const [analyze, setAnalyze] = useState(true);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file');
      if (file.size > 7_000_000) throw new Error('File too large (max 7 MB)');
      const content = await file.text();
      const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
      return api<{ searchJobId: string; imported: number; skipped: number; errors: string[] }>('/api/import', { body: { format, content, defaults: { niche, location, country }, analyzeWebsites: analyze } });
    },
    onSuccess: (r) => {
      setResult(r);
      toast.ok(`${r.imported} companies imported — processing…`);
      navigate(`/jobs/${r.searchJobId}`);
    },
    onError: (e) => toast.error(e instanceof ApiError || e instanceof Error ? e.message : 'Import failed'),
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Import companies" subtitle="CSV or JSON. Imported rows go through the same pipeline: dedupe against existing data, website discovery, live analysis and qualification." />
      <Panel>
        <div className="space-y-3">
          <Field label="File (.csv or .json)" hint="Recognised columns: name/company, website/url, phone, email, address, city, postal code, country, category. JSON: an array of objects or {companies: [...]}.">
            <input type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
          </Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Niche (for rows without a category)">
              <Input required value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="dental clinics" />
            </Field>
            <Field label="Default city">
              <Input required value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Warsaw" />
            </Field>
            <Field label="Default country">
              <Input required value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Poland" />
            </Field>
          </div>
          <Checkbox label="Analyse websites live after import" checked={analyze} onChange={setAnalyze} />
          <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => m.mutate()} loading={m.isPending} disabled={!file || !niche || !location || !country}>
            Import
          </Button>
          {result && result.errors.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-[12px] text-warn">
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
      <Panel title="Data handling">
        <p className="text-[12.5px] text-ink-2">Only import data you are allowed to use (your own lists, exports from tools you license, or publicly published business information). Values are sanitised; invalid e-mails/URLs are dropped and reported; provenance is recorded as “Import”.</p>
      </Panel>
    </div>
  );
}
