function cloneState(state) {
  try {
    return JSON.parse(JSON.stringify(state || {}));
  } catch (_e) {
    return { duration: 20, tracks: [] };
  }
}

function clamp(value, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function makeRangeInput(value, min, max, step = "0.5") {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = step;
  input.value = String(value);
  return input;
}

window.ShopliveTwickAdapter = {
  mount({ container, state, onChange, onSelect, onAddSegment, onDeleteSegment, onDuplicateSegment, onRenameSegment }) {
    let current = cloneState(state);
    let disposed = false;

    function emitChange() {
      if (disposed) return;
      onChange?.(cloneState(current));
    }

    function render() {
      if (disposed || !container) return;
      container.innerHTML = "";
      container.classList.add("twick-mvp-root");

      const header = document.createElement("div");
      header.className = "twick-mvp-header";
      const durationText = Number(current?.duration || 0) > 0 ? `${Number(current.duration).toFixed(1)}s` : "--";
      header.textContent = `Twick MVP Timeline · Duration ${durationText}`;
      container.appendChild(header);

      const tracks = Array.isArray(current?.tracks) ? current.tracks : [];
      tracks.forEach((track, trackIndex) => {
        const row = document.createElement("div");
        row.className = "twick-mvp-track";

        const label = document.createElement("div");
        label.className = "twick-mvp-track-label";
        label.textContent = track?.label || `Track ${trackIndex + 1}`;
        row.appendChild(label);

        const segWrap = document.createElement("div");
        segWrap.className = "twick-mvp-segments";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "twick-mvp-add-btn";
        addBtn.textContent = "+ Segment";
        addBtn.addEventListener("click", () => {
          if (typeof onAddSegment === "function") {
            onAddSegment(trackIndex);
            return;
          }
          const segId = `${track?.id || "track"}-seg-${Date.now()}`;
          const seg = {
            id: segId,
            title: "New Segment",
            start: 0,
            length: 20,
            color: "#3f78ff",
          };
          const list = Array.isArray(track.segments) ? track.segments : [];
          list.push(seg);
          track.segments = list;
          emitChange();
        });
        segWrap.appendChild(addBtn);
        const segs = Array.isArray(track?.segments) ? track.segments : [];
        segs.forEach((seg, segIndex) => {
          const card = document.createElement("div");
          card.className = "twick-mvp-seg";

          const title = document.createElement("div");
          title.className = "twick-mvp-seg-title";
          title.textContent = seg?.title || seg?.id || `Seg ${segIndex + 1}`;
          title.style.borderLeft = `4px solid ${seg?.color || "#3f78ff"}`;
          const dupBtn = document.createElement("button");
          dupBtn.type = "button";
          dupBtn.className = "twick-mvp-dup-btn";
          dupBtn.textContent = "Copy";
          dupBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            if (typeof onDuplicateSegment === "function") {
              onDuplicateSegment(trackIndex, String(seg?.id || ""));
              return;
            }
            const list = Array.isArray(track.segments) ? track.segments : [];
            const idx = list.findIndex((x) => String(x?.id) === String(seg?.id));
            if (idx < 0) return;
            const source = list[idx];
            list.splice(idx + 1, 0, {
              ...source,
              id: `${source.id}-copy-${Date.now()}`,
              title: `${source.title || "Segment"} Copy`,
              start: clamp((source.start || 0) + (source.length || 12) + 1, 0, 96),
            });
            emitChange();
          });
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "twick-mvp-del-btn";
          delBtn.textContent = "Delete";
          delBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            if (typeof onDeleteSegment === "function") {
              onDeleteSegment(trackIndex, String(seg?.id || ""));
              return;
            }
            const list = Array.isArray(track.segments) ? track.segments : [];
            if (list.length <= 1) return;
            const idx = list.findIndex((x) => String(x?.id) === String(seg?.id));
            if (idx >= 0) {
              list.splice(idx, 1);
              emitChange();
            }
          });
          const titleRow = document.createElement("div");
          titleRow.className = "twick-mvp-title-row";
          titleRow.appendChild(title);
          titleRow.appendChild(dupBtn);
          titleRow.appendChild(delBtn);
          card.appendChild(titleRow);

          const nameRow = document.createElement("div");
          nameRow.className = "twick-mvp-row";
          const nameLabel = document.createElement("span");
          nameLabel.textContent = "Title";
          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.className = "twick-mvp-title-input";
          nameInput.value = String(seg?.title || seg?.id || "");
          nameInput.maxLength = 48;
          nameInput.addEventListener("click", (event) => event.stopPropagation());
          nameInput.addEventListener("change", () => {
            const nextTitle = String(nameInput.value || "").trim();
            if (!nextTitle) return;
            if (typeof onRenameSegment === "function") {
              onRenameSegment(trackIndex, String(seg?.id || ""), nextTitle);
              return;
            }
            seg.title = nextTitle;
            emitChange();
          });
          nameRow.appendChild(nameLabel);
          nameRow.appendChild(nameInput);
          nameRow.appendChild(document.createElement("span"));
          card.appendChild(nameRow);

          card.addEventListener("click", () => {
            onSelect?.({ trackIndex, segId: String(seg?.id || "") });
          });

          const startRow = document.createElement("div");
          startRow.className = "twick-mvp-row";
          const startInput = makeRangeInput(clamp(seg?.start, 0, 100), 0, 100);
          const startVal = document.createElement("span");
          startVal.textContent = `${clamp(seg?.start, 0, 100).toFixed(1)}%`;
          startInput.addEventListener("input", () => {
            const next = clamp(startInput.value, 0, 100);
            const len = clamp(seg.length, 4, 100 - next);
            seg.start = next;
            seg.length = len;
            startVal.textContent = `${next.toFixed(1)}%`;
            emitChange();
          });
          startRow.appendChild(document.createTextNode("Start"));
          startRow.appendChild(startInput);
          startRow.appendChild(startVal);
          card.appendChild(startRow);

          const lenRow = document.createElement("div");
          lenRow.className = "twick-mvp-row";
          const lenInput = makeRangeInput(clamp(seg?.length, 4, 100), 4, 100);
          const lenVal = document.createElement("span");
          lenVal.textContent = `${clamp(seg?.length, 4, 100).toFixed(1)}%`;
          lenInput.addEventListener("input", () => {
            const maxLen = Math.max(4, 100 - clamp(seg.start, 0, 100));
            const next = clamp(lenInput.value, 4, maxLen);
            seg.length = next;
            lenVal.textContent = `${next.toFixed(1)}%`;
            emitChange();
          });
          lenRow.appendChild(document.createTextNode("Length"));
          lenRow.appendChild(lenInput);
          lenRow.appendChild(lenVal);
          card.appendChild(lenRow);

          segWrap.appendChild(card);
        });
        row.appendChild(segWrap);
        container.appendChild(row);
      });
    }

    render();
    return {
      update(nextState) {
        current = cloneState(nextState);
        render();
      },
      unmount() {
        disposed = true;
        if (container) container.innerHTML = "";
      },
    };
  },
};
