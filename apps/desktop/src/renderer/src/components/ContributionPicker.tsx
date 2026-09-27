import { useRef, useState } from 'react';
import type { OutsideContributionInput } from '@tandemise/api-contract';
import { Icon } from './Icon.js';
import { bytes } from '../lib/format.js';
import { CONTRIBUTION_FILE_MESSAGE, CONTRIBUTION_MAX_BYTES, CONTRIBUTION_TOTAL_MESSAGE } from '../lib/domain.js';

export type Contribution = OutsideContributionInput;
type FilePayload = { readonly filename: string; readonly mediaType: string; readonly dataBase64: string };

/**
 * Files and links handed in from outside (spec A1): uploads on a new mission,
 * attachments on a note, the one piece of work a hand-back brings.
 *
 * The 24 MB rules are checked here, before anything is read into memory or
 * sent, in the daemon's own words: a person who picks a file that is too big
 * learns it on the spot, not after a two-minute upload is refused. The daemon
 * enforces the same rules, so this is a courtesy, not the gate.
 */
export function ContributionPicker({
  value,
  onChange,
  max,
  label = 'Files and links',
  hint,
}: {
  value: readonly Contribution[];
  onChange: (next: Contribution[]) => void;
  /** At most this many; the add buttons go once it is reached, so "exactly one" is max 1. */
  max: number;
  label?: string;
  hint?: string;
}): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const exportInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const [linkExport, setLinkExport] = useState<FilePayload | null>(null);

  const used = value.reduce((sum, item) => sum + contributionBytes(item), 0);
  const full = value.length >= max;
  const urlProblem = url.trim() === '' || isFullUrl(url.trim()) ? null : 'A full address, starting with https://';

  /** Reads a picked file once it passes both size rules; null (with the reason shown) when it does not. */
  const take = async (file: File | undefined, extra = 0): Promise<FilePayload | null> => {
    if (file === undefined) return null;
    if (file.size > CONTRIBUTION_MAX_BYTES) {
      setProblem(CONTRIBUTION_FILE_MESSAGE);
      return null;
    }
    if (used + extra + file.size > CONTRIBUTION_MAX_BYTES) {
      setProblem(CONTRIBUTION_TOTAL_MESSAGE);
      return null;
    }
    setReading(true);
    try {
      const payload = await readAsBase64(file);
      setProblem(null);
      return payload;
    } catch {
      setProblem(`Could not read ${file.name}.`);
      return null;
    } finally {
      setReading(false);
    }
  };

  const addFile = async (file: File | undefined): Promise<void> => {
    const payload = await take(file);
    if (payload !== null) onChange([...value, { kind: 'file', ...payload }]);
  };

  const addLink = (): void => {
    const trimmed = url.trim();
    if (trimmed === '' || urlProblem !== null) return;
    onChange([...value, { kind: 'link', url: trimmed, ...(linkExport === null ? {} : { export: linkExport }) }]);
    setUrl('');
    setLinkExport(null);
    setLinking(false);
  };

  const remove = (index: number): void => {
    onChange(value.filter((_, i) => i !== index));
    setProblem(null);
  };

  return (
    <div className="field contrib">
      <span className="field__label">{label}</span>
      {value.length > 0 ? (
        <ul className="contrib__list" aria-label="Added">
          {value.map((item, index) => (
            <li key={`${index}-${item.kind === 'file' ? item.filename : item.url}`} className="chip contrib__chip">
              <Icon name={item.kind === 'file' ? 'file' : 'link'} size={11} />
              <span className="truncate" title={item.kind === 'file' ? item.filename : item.url}>
                {item.kind === 'file' ? item.filename : item.url}
              </span>
              {item.kind === 'file' ? <span className="contrib__size">{bytes(contributionBytes(item))}</span> : null}
              {item.kind === 'link' && item.export ? <span className="contrib__size">+ {item.export.filename}</span> : null}
              <button type="button" className="contrib__remove" aria-label={`Remove ${item.kind === 'file' ? item.filename : item.url}`} onClick={() => remove(index)}>
                <Icon name="x" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {linking ? (
        <div className="contrib__link">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLink();
              }
            }}
            placeholder="https://www.figma.com/file/…"
            aria-label="Link"
            autoFocus
          />
          <div className="contrib__row">
            <button type="button" className="btn btn--ghost" disabled={reading} onClick={() => exportInput.current?.click()}>
              <Icon name="filePlus" size={12} />
              {linkExport ? `Export: ${linkExport.filename}` : 'Attach an export'}
            </button>
            <span className="contrib__hint">Only a GitHub pull request can be read from its link; anything else needs an export.</span>
            <div className="spacer" />
            <button type="button" className="btn btn--ghost" onClick={() => { setLinking(false); setUrl(''); setLinkExport(null); }}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={url.trim() === '' || urlProblem !== null} onClick={addLink}>
              Add
            </button>
          </div>
          {urlProblem ? <span className="field__error">{urlProblem}</span> : null}
        </div>
      ) : !full ? (
        <div className="contrib__row">
          <button type="button" className="btn" disabled={reading} onClick={() => fileInput.current?.click()}>
            <Icon name="filePlus" size={12} />
            {reading ? 'Reading…' : 'Add file'}
          </button>
          <button type="button" className="btn" onClick={() => { setLinking(true); setProblem(null); }}>
            <Icon name="link" size={12} />
            Add link
          </button>
          {hint ? <span className="contrib__hint">{hint}</span> : null}
        </div>
      ) : null}

      {problem ? <span className="field__error" role="alert">{problem}</span> : null}

      {/* The inputs stay hidden: the buttons above say what they do, a native file control does not. */}
      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again (after removing it) still fires.
          e.target.value = '';
          void addFile(file);
        }}
      />
      <input
        ref={exportInput}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void take(file).then((payload) => payload !== null && setLinkExport(payload));
        }}
      />
    </div>
  );
}

/** Decoded bytes a contribution adds to the request's total, counted as the daemon counts them. */
export function contributionBytes(item: Contribution): number {
  if (item.kind === 'file') return decodedSize(item.dataBase64);
  return item.export === undefined ? 0 : decodedSize(item.export.dataBase64);
}

function decodedSize(dataBase64: string): number {
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  return Math.floor(dataBase64.length / 4) * 3 - padding;
}

function isFullUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The file as base64, without the `data:` prefix; an unknown type goes as octet-stream rather than empty. */
function readAsBase64(file: File): Promise<FilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve({ filename: file.name, mediaType: file.type || 'application/octet-stream', dataBase64: result.slice(result.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}
