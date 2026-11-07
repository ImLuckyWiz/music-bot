import type { PlayerQueueEntry } from "../contract";
import { CloseIcon, LoaderIcon, PlayIcon } from "./icons";
import { useUserName } from "./store";

type QueueRowProps = {
  item: PlayerQueueEntry;
  isBusy: boolean;
  canJump: boolean;
  canRemove: boolean;
  onJump: (position: number) => void;
  onRemove: (position: number) => void;
};

const QueueRow = ({
  item,
  isBusy,
  canJump,
  canRemove,
  onJump,
  onRemove,
}: QueueRowProps) => {
  const addedBy = useUserName(item.invokerUserId);

  return (
    <li className="mb-row">
      <div className="mb-row-lead">
        <span className="mb-row-num">{item.position}</span>
        <button
          type="button"
          className="mb-ctrl mb-row-play"
          title="Play now"
          aria-label={`Play ${item.label} now`}
          disabled={isBusy || !canJump}
          onClick={() => onJump(item.position)}
        >
          <PlayIcon size={14} />
        </button>
      </div>

      <div>
        <div className="mb-row-label">
          {item.isResolving ? (
            <span className="mb-row-resolving">
              <LoaderIcon size={12} />
              <span>Fetching song info...</span>
            </span>
          ) : (
            item.label
          )}
        </div>
        <div className="mb-row-meta">
          {item.isResolving ? (
            <span className="mb-row-source" title={item.label}>
              {item.label}
            </span>
          ) : addedBy ? (
            `Added by ${addedBy}`
          ) : null}
        </div>
      </div>

      <button
        type="button"
        className="mb-ctrl mb-row-remove"
        title="Remove from queue"
        aria-label={`Remove ${item.label} from the queue`}
        disabled={isBusy || !canRemove}
        onClick={() => onRemove(item.position)}
      >
        <CloseIcon />
      </button>
    </li>
  );
};

type QueueProps = {
  queue: PlayerQueueEntry[];
  isBusy: boolean;
  canJump: boolean;
  canRemove: boolean;
  onJump: (position: number) => void;
  onRemove: (position: number) => void;
};

const Queue = ({
  queue,
  isBusy,
  canJump,
  canRemove,
  onJump,
  onRemove,
}: QueueProps) => (
  <div className="mb-section">
    <div className="mb-section-head">
      <span className="mb-section-title">Next up</span>
      <span className="mb-section-count">
        {queue.length === 1 ? "1 track" : `${queue.length} tracks`}
      </span>
    </div>

    <ol className="mb-list">
      {queue.map((item) => (
        <QueueRow
          key={`${item.position}-${item.label}`}
          item={item}
          isBusy={isBusy}
          canJump={canJump}
          canRemove={canRemove}
          onJump={onJump}
          onRemove={onRemove}
        />
      ))}
    </ol>
  </div>
);

export { Queue };
