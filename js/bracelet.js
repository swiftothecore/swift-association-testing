// The hand-strung friendship-bracelet keepsake, rendered as SVG.
// Pure: given the per-round results (and the picked albums), returns markup.
// Classic runs draw 13 beads with a white "13" letter bead; infinite runs pass
// { total: <rounds>, letterBead: false } so the strand grows and the beads
// shrink to fit (shrink-to-fit; no fixed cap).
import { TOTAL_ROUNDS, ALBUM_COLORS } from "./config.js";

export function starPath(cx, cy, rOut, rIn) {
  let d = "";
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? rOut : rIn;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    d += (k ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(2) + "," + (cy + r * Math.sin(a)).toFixed(2);
  }
  return d + "Z";
}

export function buildBraceletSVG(results, activeRound, freshIndex, albums, opts) {
  const total = (opts && opts.total) || TOTAL_ROUNDS;
  const letterBead = !opts || opts.letterBead !== false;
  // Album→colour map; callers pass the active palette (colour-blind variant when
  // that setting is on), defaulting to the standard album colours.
  const colors = (opts && opts.colors) || ALBUM_COLORS;
  // per-round flags: was a hint taken that round? marks the charm with a small "H".
  const hinted = (opts && opts.hinted) || [];
  const W = 520, H = 64, xL = 26, xR = W - 26;
  // the thread sags between its tied ends like a real bracelet laid on the page
  const yAt = (x) => 20 + 10 * Math.sin(Math.PI * ((x - xL) / (xR - xL)));
  const tx0 = xL - 16, tx1 = xR + 16;

  // Beads shrink as the strand grows, so a long infinite run still fits the
  // viewBox. Scale is the gap between mains relative to the classic 13-bead gap.
  const classicStep = (xR - xL) / (TOTAL_ROUNDS - 1);
  const step = total > 1 ? (xR - xL) / (total - 1) : classicStep;
  const scale = Math.max(0.45, Math.min(1, step / classicStep));
  const s = (v) => +(v * scale).toFixed(2);
  // single bead sits centred; otherwise spread evenly between the tied ends
  const beadX = (i) => total > 1
    ? +(xL + ((xR - xL) * i) / (total - 1)).toFixed(1)
    : +((xL + xR) / 2).toFixed(1);

  let d = "";
  for (let k = 0; k <= 48; k++) {
    const x = tx0 + ((tx1 - tx0) * k) / 48;
    d += (k ? "L" : "M") + x.toFixed(1) + "," + yAt(x).toFixed(1);
  }
  // two offset strands read as twisted floss
  let svg = `<path class="b-thread" d="${d}" stroke-width="1.7" opacity="0.55"/>` +
            `<path class="b-thread" d="${d}" stroke-width="1" opacity="0.35" stroke-dasharray="6 4" transform="translate(0 1.3)"/>`;

  const knot = (x, y, dir) =>
    `<path class="b-knot" stroke-width="1.3" opacity="0.65" d="M${x},${y} q${5 * dir},-7 ${2 * dir},-11 M${x},${y} q${7 * dir},1 ${11 * dir},-4"/>` +
    `<circle cx="${x}" cy="${y}" r="2.2" fill="var(--ink-soft)" opacity="0.7"/>`;
  svg += knot(tx0, yAt(tx0), -1) + knot(tx1, yAt(tx1), 1);

  // tiny seed beads strung between the main beads
  for (let i = 0; i < total - 1; i++) {
    const x = xL + ((xR - xL) * (i + 0.5)) / (total - 1);
    svg += `<circle class="b-seed" cx="${x.toFixed(1)}" cy="${yAt(x).toFixed(1)}" r="${s(1.9)}"/>`;
  }

  for (let i = 0; i < total; i++) {
    const x = beadX(i);
    const y = +yAt(x).toFixed(1);
    const answered = results[i];
    // colour this bead by the album of the song picked that round (final bracelet)
    const albumCol = (albums && albums[i]) ? (colors[albums[i]] || null) : null;
    const beadStyle = albumCol ? ` style="--bead:${albumCol}"` : "";

    if (answered === true) {
      // a small bead on the thread, with a star charm dangling from a jump ring
      svg += `<circle cx="${x}" cy="${y}" r="${s(4.1)}" class="b-bead" stroke-width="1"${beadStyle}/>`;
      const fresh = i === freshIndex;
      const delay = fresh ? "" : ` style="animation-delay:${(-(i * 0.9) % 5.5).toFixed(2)}s"`;
      // a hinted round wears a small "H" on the star charm (a hint was used here)
      const hintMark = hinted[i]
        ? `<text x="${x}" y="${y + s(15.5) + s(2.5)}" text-anchor="middle" font-size="${s(7)}" class="b-hint-h">H</text>`
        : "";
      svg += `<g class="charm-dangle${fresh ? " fresh" : ""}"${delay}>` +
        `<circle cx="${x}" cy="${y + s(5.4)}" r="${s(2.3)}" fill="none" stroke="var(--ink)" stroke-width="1" opacity="0.7"/>` +
        `<path d="${starPath(x, y + s(15.5), s(7.4), s(3.1))}" class="b-bead" stroke-width="1.1" stroke-linejoin="round"${beadStyle}/>` +
        `<circle cx="${x - s(1.9)}" cy="${y + s(12.6)}" r="${s(1.2)}" class="b-gloss"/>` +
        hintMark +
        `</g>`;
    } else if (answered === false) {
      // a quiet matte spacer bead — tinted to the picked album, kept muted
      const missStyle = albumCol ? ` style="fill:${albumCol}" fill-opacity="0.5"` : "";
      svg += `<circle cx="${x}" cy="${y}" r="${s(4.9)}" class="b-miss" stroke-width="1"${missStyle}/>` +
             `<circle cx="${x}" cy="${y}" r="${s(1.1)}" class="b-miss-dot"/>`;
    } else if (i + 1 === activeRound) {
      // the bead being strung right now: bigger, glossy, with a soft halo pulse
      svg += `<circle cx="${x}" cy="${y}" r="${s(9)}" class="b-halo" stroke-width="2"/>` +
             `<circle cx="${x}" cy="${y}" r="${s(8.4)}" class="b-bead" stroke-width="1.4"/>` +
             `<ellipse cx="${x - s(2.6)}" cy="${y - s(3.1)}" rx="${s(3)}" ry="${s(1.8)}" class="b-gloss" transform="rotate(-20 ${x - s(2.6)} ${y - s(3.1)})"/>`;
    } else if (letterBead && i === total - 1) {
      // the finale slot is a classic white letter bead (classic mode only)
      const h = s(7);
      svg += `<g transform="rotate(6 ${x} ${y})">` +
        `<rect x="${x - h}" y="${y - h}" width="${s(14)}" height="${s(14)}" rx="${s(3.5)}" class="b-letter" stroke-width="1.1" opacity="0.8"/>` +
        `<text x="${x}" y="${y + s(2.6)}" text-anchor="middle" font-size="${s(7.5)}" class="b-letter-text">13</text>` +
        `</g>`;
    } else {
      svg += `<circle cx="${x}" cy="${y}" r="${s(5.6)}" class="b-future" stroke-width="1.1"/>`;
    }
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${svg}</svg>`;
}
