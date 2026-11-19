import test from 'node:test';
import assert from 'node:assert/strict';

// The browser-side helpers are plain TypeScript with no imports, so Node (22.18+) can load them directly.
const supportsTypeStripping = Number(process.versions.node.split('.')[0]) >= 23 || process.features.typescript;
const lib = (name) => import(`../src/lib/${name}.ts`);
const options = { skip: supportsTypeStripping ? false : 'needs Node 23+ to load .ts files' };

test('web addresses: bare domains get https://, duplicate schemes are stripped, junk is flagged', options, async () => {
  const { normalizeUrl, splitUrl, urlProblem } = await lib('url');
  assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('  example.com  '), 'https://example.com');
  assert.equal(normalizeUrl('https://https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('HTTP://http://example.com/x'), 'http://example.com/x');
  assert.equal(normalizeUrl('https//example.com'), 'https://example.com');
  assert.equal(normalizeUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.equal(normalizeUrl('httpbin.org'), 'https://httpbin.org');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('https://'), '');
  assert.deepEqual(splitUrl('http://a.com'), { scheme: 'http', rest: 'a.com', explicit: true });
  assert.equal(urlProblem('example.com/page'), null);
  assert.equal(urlProblem(''), null);
  assert.match(urlProblem('javascript:alert(1)'), /https/);
  assert.match(urlProblem('ftp://files.example.com'), /https/);
  assert.match(urlProblem('not a url'), /spaces|web address/);
  assert.match(urlProblem('nodots'), /domain/);
});

test('availability: free, booked, yours, merged blocks and stays across midnight', options, async () => {
  const { statusFor, withBooking, withoutBooking, myOverlap, clock } = await lib('availabilityMath');
  const day = { date: '2030-01-02', showNames: false, busy: { a: [[540, 780, 0], [780, 840, 0], [900, 960, 1]], b: [] } };
  const next = { date: '2030-01-03', showNames: false, busy: { a: [[0, 120, 0]] } };

  assert.equal(statusFor(day, undefined, 'zzz', 600, 660).headline, 'Free all day');
  const booked = statusFor(day, undefined, 'a', 600, 660);
  assert.equal(booked.state, 'booked');
  assert.equal(booked.freeFrom, 840, 'back-to-back bookings are one block');
  assert.match(booked.headline, /Booked 9:00 am – 1:00 pm/);
  assert.match(booked.detail, /free from 2:00 pm/);
  assert.equal(statusFor(day, undefined, 'a', 840, 900).state, 'free', 'touching a booking is not a clash');
  assert.equal(statusFor(day, undefined, 'a', 840, 900).headline, 'Free until 3:00 pm');
  assert.equal(statusFor(day, undefined, 'a', 960, 1020).headline, 'Free for the rest of the day');
  assert.equal(statusFor(day, undefined, 'a', 930, 990).state, 'mine');

  // "until midnight" ends exactly at 1440 and must not touch the next day.
  assert.equal(statusFor(day, next, 'a', 1320, 1440).state, 'free');
  // A stay that runs into the next morning needs the next day's data.
  assert.equal(statusFor(day, next, 'a', 1320, 1500).state, 'booked');
  assert.equal(statusFor(day, undefined, 'a', 1320, 1500).state, 'free');
  assert.equal(clock(1440), 'midnight');
  assert.equal(clock(0), '12:00 am');
  assert.equal(clock(750), '12:30 pm');

  const added = withBooking(day, 'b', 600, 660, true);
  assert.equal(statusFor(added, undefined, 'b', 630, 700).state, 'mine');
  assert.equal(day.busy.b.length, 0, 'the original day is not changed');
  assert.equal(statusFor(withoutBooking(added, 'b', 600, 660), undefined, 'b', 630, 700).state, 'free');
  assert.equal(myOverlap(day, undefined, ['a', 'b'], 930, 990), 'a');
  assert.equal(myOverlap(day, undefined, ['a', 'b'], 600, 660), null);
});

test('seat numbers never sit on seats or on each other, and an explicit side is respected', options, async () => {
  const { layoutLabels, labelFont, labelRect, markerRect } = await lib('labelLayout');
  const aspect = 1684 / 1191;
  const items = [];
  // Pods of two facing rows of five (a dense layout), like a real office floor.
  for (let pod = 0; pod < 8; pod += 1) {
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const n = pod * 10 + row * 5 + col + 1;
        items.push({ id: `s${n}`, x: 9 + (pod % 4) * 13.2 + col * 1.7, y: 9 + Math.floor(pod / 4) * 14.5 + row * 2.4, text: String(n).padStart(3, '0') });
      }
    }
  }
  items[3] = { ...items[3], side: 'left' };
  const placement = layoutLabels(items, aspect);
  assert.equal(placement.size, items.length);
  assert.equal(placement.get('s4').side, 'left');

  for (const width of [850, 1250, 1900, 3000, 6000, 12000]) {
    const shown = items.filter((item) => width >= placement.get(item.id).minWidth);
    const boxes = shown.map((item) => {
      const spot = { x: (item.x / 100) * width, y: (item.y / 100 / aspect) * width };
      const move = (r) => ({ x0: r.x0 + spot.x, x1: r.x1 + spot.x, y0: r.y0 + spot.y, y1: r.y1 + spot.y });
      return { item, label: move(labelRect(placement.get(item.id).side, item.text, width)) };
    });
    const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    for (const { item, label } of boxes) {
      for (const other of items) {
        const spot = { x: (other.x / 100) * width, y: (other.y / 100 / aspect) * width };
        const dot = markerRect(other, width);
        const dotBox = { x0: dot.x0 + spot.x, x1: dot.x1 + spot.x, y0: dot.y0 + spot.y, y1: dot.y1 + spot.y };
        // A label can touch its own seat's edge but never another seat's dot.
        if (other.id !== item.id) assert.ok(!hit(label, dotBox), `${item.id} label covers seat ${other.id} at width ${width}`);
      }
    }
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!hit(boxes[i].label, boxes[j].label), `labels ${boxes[i].item.id} and ${boxes[j].item.id} overlap at width ${width}`);
  }
  // Fully zoomed in, every number is shown; at fit-to-screen the crowded ones are hidden instead of piling up.
  assert.equal([...placement.values()].filter((p) => 12000 >= p.minWidth).length, items.length);
  assert.ok([...placement.values()].filter((p) => 850 >= p.minWidth).length < items.length);
  assert.ok(labelFont(800) <= labelFont(8000));
});
