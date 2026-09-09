import { useState } from 'react';
import type { Balances } from '../../protocols/shared/types';
import { formatAmount } from '../lib/tokens';

// No mint-versus-balance warning here. The browser's coin store records only
// what this browser minted, and the wallet's sNight moves independently of it:
// a reverse conversion (any amount, funded by wallet coin selection), a
// transfer, or a mint from another browser all make "minted here" differ from
// the wallet total legitimately. The old warning fired on exactly those cases.
export function BalancePanel({
  balances,
  onRefresh,
}: {
  balances?: Balances;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyId = (label: string, id?: string) => {
    if (!id) return;
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied((c) => (c === label ? null : c)), 1200);
      })
      .catch(() => undefined);
  };

  // Token label: dotted-underlined, hover shows the token id, click copies it.
  const TokenLabel = ({ label, id }: { label: string; id?: string }) =>
    id ? (
      <span
        className="bal-k token-id"
        title={`${id}\n(click to copy)`}
        onClick={() => copyId(label, id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && copyId(label, id)}
      >
        {copied === label ? 'copied ✓' : label}
      </span>
    ) : (
      <span className="bal-k">{label}</span>
    );

  return (
    <div className="balances">
      <div className="balances-row">
        <span className="bal">
          <TokenLabel label="NIGHT" id={balances?.nativeTokenId} />
          <span className="bal-v">{balances ? formatAmount(balances.nativeNight) : '-'}</span>
        </span>
        <span className="bal-sep">·</span>
        <span className="bal">
          <TokenLabel label="sNight" id={balances?.wrapperTokenId} />
          <span className="bal-v">{balances ? formatAmount(balances.wrapper) : '-'}</span>
        </span>
        <button className="link-btn" onClick={onRefresh} title="Refresh balances">
          ↻
        </button>
      </div>
    </div>
  );
}
