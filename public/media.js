// Foto/video dibaca oleh browser dari /uploads (cookie login ikut terkirim).
// Tidak memakai fetch().blob(): video besar cukup memuat metadata dan byte yang diminta.
(function () {
    'use strict';
    const images = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico', 'heic', 'heif']);
    const videos = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', '3gp', '3g2']);
    window.fileMediaKind = name => {
        const ext = String(name).split('.').pop().toLowerCase();
        return images.has(ext) ? 'image' : videos.has(ext) ? 'video' : '';
    };
    let viewer, stage, status, active, items = [], index = 0;

    function releaseMedia() {
        if (active) {
            const old = active; active = null;
            if (old.tagName === 'VIDEO') old.pause();
            old.removeAttribute('src');
            if (old.tagName === 'VIDEO') old.load();
        }
        if (stage) stage.replaceChildren();
    }

    function ensureViewer() {
        if (viewer) return;
        viewer = document.createElement('dialog');
        viewer.id = 'media-viewer'; viewer.className = 'media-viewer';
        viewer.setAttribute('aria-labelledby', 'media-title');
        viewer.innerHTML = `
            <header class="media-toolbar">
                <div class="media-heading"><h2 id="media-title"></h2><span class="media-detail" id="media-detail"></span></div>
                <button type="button" id="media-close" data-i18n="media.close"></button>
            </header>
            <div class="media-stage" id="media-stage"></div>
            <p class="media-status" id="media-status" role="status" aria-live="polite"></p>
            <footer class="media-footer">
                <button type="button" id="media-prev" data-i18n="media.prev"></button>
                <span class="media-position" id="media-position"></span>
                <button type="button" id="media-next" data-i18n="media.next"></button>
                <a id="media-download" download data-i18n="fs.download"></a>
            </footer>`;
        document.body.appendChild(viewer);
        stage = viewer.querySelector('#media-stage'); status = viewer.querySelector('#media-status');
        viewer.querySelector('#media-close').onclick = () => viewer.close();
        viewer.querySelector('#media-prev').onclick = () => showItem(index - 1);
        viewer.querySelector('#media-next').onclick = () => showItem(index + 1);
        viewer.addEventListener('close', releaseMedia);
        viewer.addEventListener('click', e => {
            if (e.target !== viewer) return;
            const r = viewer.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) viewer.close();
        });
        viewer.addEventListener('keydown', e => {
            // Tombol panah pada video tetap untuk seek/volume bawaan browser.
            if (e.target.tagName === 'VIDEO') return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault(); showItem(index + (e.key === 'ArrowLeft' ? -1 : 1));
            }
        });
    }

    function showItem(next) {
        if (next < 0 || next >= items.length) return;
        releaseMedia(); index = next;
        const file = items[index], kind = fileMediaKind(file.name);
        viewer.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        viewer.querySelector('#media-title').textContent = file.name;
        viewer.querySelector('#media-detail').textContent = formatBytes(file.size);
        viewer.querySelector('#media-position').textContent = `${index + 1} / ${items.length}`;
        viewer.querySelector('#media-prev').disabled = index === 0;
        viewer.querySelector('#media-next').disabled = index === items.length - 1;
        viewer.querySelector('#media-download').href = '/api/download?path=' + encodeURIComponent(file.path);
        status.hidden = false; status.classList.remove('media-failed'); status.textContent = t('media.loading');
        const el = document.createElement(kind === 'video' ? 'video' : 'img');
        active = el;
        el.addEventListener(kind === 'video' ? 'loadedmetadata' : 'load', () => {
            if (active === el) status.hidden = true;
        });
        el.addEventListener('error', () => {
            if (active !== el) return;
            status.hidden = false; status.classList.add('media-failed');
            status.textContent = t(kind === 'video' ? 'media.videoError' : 'media.imageError');
        });
        if (kind === 'video') { el.controls = true; el.playsInline = true; el.preload = 'metadata'; }
        else { el.alt = file.name; el.decoding = 'async'; }
        // Encode per segmen: spasi, #, %, kutip, emoji, dan subfolder tetap utuh.
        el.src = '/uploads/' + file.path.split('/').map(encodeURIComponent).join('/');
        stage.appendChild(el);
    }

    window.openMediaFile = encodedName => {
        const name = decodeURIComponent(encodedName);
        items = fetchedFileList.filter(f => !f.isDirectory && fileMediaKind(f.name))
            .map(f => ({ ...f, path: currentPath ? currentPath + '/' + f.name : f.name }));
        const selected = items.findIndex(f => f.name === name);
        if (selected < 0) return;
        closeActionMenus(); ensureViewer(); showItem(selected);
        if (!viewer.open) viewer.showModal();
    };
    window.closeMediaViewer = () => { if (viewer && viewer.open) { releaseMedia(); viewer.close(); } };
})();
