// ============================================================================
// skills.js — tampilan kompatibilitas dari skills-registry.js.
//
// Sumber kebenaran sekarang SATU: skills-registry.js (nama, deskripsi, schema,
// validator, kebijakan, handler, ketersediaan). Modul ini hanya menyediakan
// daftar nama/deskripsi + system prompt untuk pemanggil lama (dan halaman web).
// ============================================================================
const createRegistry = require('./skills-registry');

// Instance tanpa dependensi: hanya metadata yang dipakai, handler tidak dipanggil.
const registry = createRegistry({});

module.exports = {
    skills: registry.skills,
    SKILLS: registry.skills,
    systemPrompt: registry.systemPrompt,
    declarations: registry.declarations,
    names: registry.names
};
