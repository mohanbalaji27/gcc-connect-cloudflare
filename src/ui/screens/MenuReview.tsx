import { useState } from 'react';
import { COMMENT_MAX, MEALS, type MealId, type ReviewVisibility } from '../../lib/menuCatalog';
import { api, messageOf } from '../../lib/api';
import type { MealState, MenuDish, MyMealReview } from '../../lib/menuData';
import { Icon, Modal, Switch, useKit } from '../kit';
import { DietMark, StarInput } from '../MenuBits';

const PRIVACY: Record<ReviewVisibility, string> = {
  everyone: 'Everyone can read your comment, with your name. Turn on anonymous to hide it.',
  summary: 'Everyone sees the average stars. Only the food team reads your comment.',
  managers: 'Only the food team sees reviews. Other employees never see yours.',
};

export function ReviewSheet({ date, dateLabel, meal, dishes, mine, myDishes, visibility, canSeeReviews, onClose, onSaved }: {
  date: string; dateLabel: string; meal: MealId; dishes: MenuDish[]; mine: MyMealReview | null; myDishes: Record<string, number>;
  visibility: ReviewVisibility; canSeeReviews: boolean; onClose: () => void; onSaved: (state: MealState) => void;
}) {
  const { toast } = useKit();
  const [stars, setStars] = useState(mine?.rating ?? 0);
  const [comment, setComment] = useState(mine?.comment ?? '');
  const [anonymous, setAnonymous] = useState(mine?.anonymous ?? false);
  const [dishStars, setDishStars] = useState<Record<string, number>>(() => Object.fromEntries(dishes.map((dish) => [dish.id, myDishes[dish.id] ?? 0])));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const rated = dishes.filter((dish) => dishStars[dish.id] > 0 || (myDishes[dish.id] ?? 0) > 0).map((dish) => ({ itemId: dish.id, rating: dishStars[dish.id] ?? 0 }));
      const state = await api<MealState>('/menu/review', { method: 'PUT', body: { date, meal, rating: stars, comment, anonymous, dishes: rated } });
      toast(mine ? 'Review updated. Thank you!' : 'Thanks for the feedback!', 'success');
      onSaved(state);
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      onSaved(await api<MealState>(`/menu/review?date=${date}&meal=${meal}`, { method: 'DELETE' }));
      toast('Your review was removed.', 'info');
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Rate ${MEALS[meal].label.toLowerCase()}`} onClose={onClose}>
      <div className="review-sheet">
        <p className="muted">{MEALS[meal].emoji} {MEALS[meal].label} · {dateLabel}</p>
        <StarInput value={stars} onChange={setStars} label="Your rating" />
        <label className="field"><span>Comment (optional)</span>
          <textarea rows={3} value={comment} maxLength={COMMENT_MAX} onChange={(event) => setComment(event.target.value)} placeholder="What was great, or what should the kitchen change?" />
          <small>{comment.length}/{COMMENT_MAX}</small>
        </label>
        <div className="review-anon">
          <div><strong>Post anonymously</strong><small>{anonymous ? 'Your name is never shown to anyone, not even the food team.' : PRIVACY[visibility]}</small></div>
          <Switch checked={anonymous} onChange={setAnonymous} label="Post anonymously" />
        </div>
        {!canSeeReviews && visibility === 'managers' && <small className="muted">You will see your own review here; the average stays with the food team.</small>}
        {dishes.length > 0 && (
          <details className="review-dishes">
            <summary>Rate single dishes <small>(optional)</small></summary>
            <ul>
              {dishes.map((dish) => (
                <li key={dish.id}>
                  <span><DietMark diet={dish.diet} small /> {dish.name}</span>
                  <StarInput size="sm" clearable value={dishStars[dish.id] ?? 0} onChange={(value) => setDishStars((current) => ({ ...current, [dish.id]: value }))} label={`Rating for ${dish.name}`} />
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="modal-actions">
          {mine && <button type="button" className="button button-danger-soft" disabled={busy} onClick={() => void remove()}><Icon name="trash" size={16} /> Remove</button>}
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="button" className="button button-primary" disabled={busy || stars < 1} onClick={() => void save()}>{busy ? 'Saving…' : mine ? 'Update review' : 'Post review'}</button>
        </div>
      </div>
    </Modal>
  );
}
