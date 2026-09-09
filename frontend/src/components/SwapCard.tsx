import { useState } from 'react';
import type { ShieldedNightState } from '../hooks/useShieldedNight';
import { errMsg } from '../hooks/useShieldedNight';
import { formatAmount, parseAmount } from '../lib/tokens';
import type { Direction, SwapStep } from '../../protocols/shared/types';

const TOKENS = {
  toShielded: { from: 'NIGHT', to: 'sNight' },
  toUnshielded: { from: 'sNight', to: 'NIGHT' },
} as const;

export function SwapCard({ sn }: { sn: ShieldedNightState }) {
  const [direction, setDirection] = useState<Direction>('toShielded');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<SwapStep | null>(null);
  const [stepLabel, setStepLabel] = useState('');
  const [localErr, setLocalErr] = useState<string>();

  const { from, to } = TOKENS[direction];
  const blockedCoins = sn.balances?.blockedWrapperCoins ?? [];
  // Reverse conversion spends the wallet's sNight balance: the wallet funds the
  // contract-owned output with its own coin selection, so any amount up to the
  // total works regardless of which browser or wallet minted those coins.
  const walletWrapper = sn.balances?.wrapper ?? 0n;
  const ready = sn.connected
    && !!sn.contractAddress
    && !sn.configurationError
    && (direction === 'toShielded' || walletWrapper > 0n);

  const flip = () => {
    setDirection((d) => (d === 'toShielded' ? 'toUnshielded' : 'toShielded'));
    setLocalErr(undefined);
  };

  // Max = the wallet's balance in the "from" token: NIGHT for forward, sNight
  // for reverse (the wallet funds the conversion + change during balancing).
  const maxBase = direction === 'toShielded'
    ? (sn.balances?.nativeNight ?? 0n)
    : walletWrapper;
  const onMax = () => {
    setLocalErr(undefined);
    setAmount(formatAmount(maxBase));
  };

  async function onSwap() {
    setLocalErr(undefined);
    if (!sn.session || !sn.contractAddress) return;
    let amt: bigint;
    try {
      amt = parseAmount(amount);
      if (amt <= 0n) throw new Error('Enter an amount greater than zero');
    } catch (e) {
      setLocalErr(errMsg(e));
      return;
    }

    // Reverse conversion is bounded by the wallet's sNight balance. Check it
    // here so the message can be formatted in sNight (the adapter's own check
    // is the authoritative backstop, but it only knows base units and would
    // otherwise log "approve in wallet" for an amount we already know is too
    // large).
    if (direction === 'toUnshielded' && amt > walletWrapper) {
      setLocalErr(`The wallet holds ${formatAmount(walletWrapper)} sNight; enter an amount up to that total.`);
      return;
    }

    setBusy(true);
    setStep('started');
    try {
      const cb = {
        onStep: (s: SwapStep, label: string) => {
          setStep(s);
          setStepLabel(label);
        },
        onLog: sn.appendLog,
      };
      await sn.convert(direction, amt, cb);
      setAmount('');
    } catch (e) {
      setLocalErr(errMsg(e));
      sn.appendLog('Swap error: ' + errMsg(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStep(null), 1500);
    }
  }

  return (
    <div className="card">
      <h2>Convert</h2>

      <div className="leg">
        <div>
          <div className="label">From</div>
          <div className="token">{from}</div>
        </div>
        <div className="amount-field">
          <input
            className="input amount-input"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button className="max-btn" onClick={onMax} disabled={busy || maxBase === 0n} title={`Use max (${formatAmount(maxBase)})`}>
            Max
          </button>
        </div>
      </div>

      <div className="swap-arrow">
        <button
          className={direction === 'toUnshielded' ? 'flipped' : ''}
          onClick={flip}
          disabled={busy}
          title="Switch direction"
          aria-label="Switch direction"
        >
          ↓
        </button>
      </div>

      <div className="leg">
        <div>
          <div className="label">To</div>
          <div className="token">{to}</div>
        </div>
        <div className="amt muted">{amount && isFinite(Number(amount)) ? amount : '0.0'}</div>
      </div>

      {direction === 'toUnshielded' && (
        <>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Wallet total: <b>{formatAmount(walletWrapper)}</b> sNight.
          </p>
          {blockedCoins.length > 0 && (
            <p className="small warn" style={{ marginBottom: 0 }}>
              {blockedCoins.map((coin) => `${formatAmount(coin.value)} sNight ${coin.status}${coin.transactionId ? ` (tx ${coin.transactionId}, ${coin.networkId ?? sn.networkKey})` : ' (no transaction id recorded)'}`).join('; ')}. This browser minted those coins without a confirmed outcome; check their transactions. They do not restrict what you can convert back.
            </p>
          )}
        </>
      )}

      {step && (
        <div className="steps">
          <div className={`step ${step === 'done' ? 'done' : 'active'}`}>{stepLabel || 'Converting…'}</div>
        </div>
      )}

      {localErr && <p className="err small">{localErr}</p>}

      <div className="spacer" />
      <button className="btn btn-primary btn-block" disabled={!ready || busy || sn.operationPending} onClick={onSwap}>
        {busy ? 'Converting…' : `Swap ${from} → ${to}`}
      </button>
      {!ready && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {sn.configurationError
            ? sn.configurationError
            : direction === 'toUnshielded' && sn.connected && walletWrapper === 0n
              ? 'No sNight in the wallet.'
            : sn.connected
              ? `Reconnect the wallet to ${sn.networkKey}.`
            : 'Connect a wallet to swap.'}
        </p>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        One transaction, one wallet approval.
      </p>
    </div>
  );
}
