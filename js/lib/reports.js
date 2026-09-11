// js/lib/reports.js
//
// Occupancy and revenue for a span of nights, computed from the night ledger.
// Pure: rooms, ledger cells and the clock go in; figures come out.
//
// What counts:
//   - SOLD is a confirmed night, earning the rate stamped on that night when a
//     person agreed it — never today's room price, so a later price change does
//     not rewrite last month's takings.
//   - HELD is a web hold still inside its two hours. It is shown, and earns
//     nothing yet. A lapsed hold is ignored.
//   - A cancelled booking has no nights left in the ledger, so it cannot count.
//   - Revenue belongs to the night slept, not the day the booking was made.
//   - Figures are gross, as charged to the guest.

import { dateRange } from './dates.js';
import { cellBlocks } from './availability.js';

/** 'YYYY-MM' → the first and last night of that month. */
export function monthSpan(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) throw new Error('month must be YYYY-MM');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export function summarize({ rooms, cells, from, to, nowMs = Date.now() }) {
  const days   = dateRange(from, to);
  const inSpan = new Set(days);

  const byDay  = new Map(days.map(d => [d, { date: d, sold: 0, held: 0, revenue: 0 }]));
  const byRoom = new Map(rooms.map(r => [r.id, {
    roomId: r.id, number: r.number, type: r.type, rate: r.rate, active: r.active !== false,
    sold: 0, held: 0, revenue: 0,
  }]));

  let unpriced = 0;

  for (const cell of cells) {
    if (!inSpan.has(cell.date)) continue;
    const day  = byDay.get(cell.date);
    const room = byRoom.get(cell.roomId);

    if (cell.status === 'confirmed') {
      const priced = Number.isFinite(cell.rate);
      const rate   = priced ? cell.rate : 0;
      if (!priced) unpriced++;
      day.sold++;
      day.revenue += rate;
      if (room) { room.sold++; room.revenue += rate; }
    } else if (cellBlocks(cell, nowMs)) {
      day.held++;
      if (room) room.held++;
    }
  }

  const dayList  = [...byDay.values()];
  const sold     = dayList.reduce((n, d) => n + d.sold, 0);
  const held     = dayList.reduce((n, d) => n + d.held, 0);
  const revenue  = dayList.reduce((n, d) => n + d.revenue, 0);
  const capacity = rooms.length * days.length;

  return {
    from, to,
    days: days.length,
    rooms: rooms.length,
    capacity,                 // room-nights there were to sell
    sold,
    held,
    revenue,
    unpriced,                 // confirmed nights with no rate on them: shown, not guessed
    occupancy:                capacity ? sold / capacity : 0,
    averageRate:              sold ? Math.round(revenue / sold) : 0,
    revenuePerAvailableNight: capacity ? Math.round(revenue / capacity) : 0,
    byDay: dayList,
    byRoom: [...byRoom.values()].map(r => ({
      ...r,
      occupancy: days.length ? r.sold / days.length : 0,
    })),
  };
}
