/* =====================================================
   HigherSpace Connect — app.js
   Core, site-wide behaviour.
===================================================== */

/**
 * Sends the value of #searchInput to category.html as a
 * free-text query. If the field is empty, it's a no-op.
 */
function goToSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;

    const query = input.value.trim();
    if (!query) {
        input.focus();
        return;
    }

    window.location.href = 'category.html?q=' + encodeURIComponent(query);
}

/* Let the search box submit on Enter, not just the button click. */
document.addEventListener('DOMContentLoaded', function () {
    const input = document.getElementById('searchInput');
    if (!input) return;

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            goToSearch();
        }
    });
});


/* =====================================================
   INSTITUTIONS DIRECTORY
   Search box + type filter chips + county dropdown,
   all combined into one query string for institutions.html.
===================================================== */

let currentInstitutionFilter = 'all';
let currentCountyFilter = '';

/**
 * Sets the active institution-type filter (all / university /
 * tvet / college) and updates the chip styling to match.
 */
function setInstitutionFilter(filter, buttonEl) {
    currentInstitutionFilter = filter;

    document.querySelectorAll('.filter-chip').forEach(function (chip) {
        chip.classList.remove('active');
    });

    if (buttonEl) {
        buttonEl.classList.add('active');
    }
}

/**
 * Sets the active county filter from the <select> dropdown.
 */
function setCountyFilter(value) {
    currentCountyFilter = value;
}

/**
 * Sends the institution search box value, plus whichever type
 * and county filters are active, to institutions.html.
 */
function goToInstitutionSearch() {
    const input = document.getElementById('institutionSearchInput');
    const query = input ? input.value.trim() : '';

    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (currentInstitutionFilter && currentInstitutionFilter !== 'all') {
        params.set('type', currentInstitutionFilter);
    }
    if (currentCountyFilter) params.set('county', currentCountyFilter);

    const qs = params.toString();
    window.location.href = 'institutions.html' + (qs ? '?' + qs : '');
}

/* Let the institution search box submit on Enter too. */
document.addEventListener('DOMContentLoaded', function () {
    const input = document.getElementById('institutionSearchInput');
    if (!input) return;

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            goToInstitutionSearch();
        }
    });
});


/* =====================================================
   MY CAMPUS
   Lets a student pick their institution once and see a
   personalized panel of quick links. The choice is
   remembered in localStorage between visits.
===================================================== */

const MY_CAMPUS_STORAGE_KEY = 'higherspace-my-campus';

const MY_CAMPUS_INSTITUTIONS = {
    uon: 'University of Nairobi',
    ku: 'Kenyatta University',
    jkuat: 'JKUAT',
    moi: 'Moi University',
    strathmore: 'Strathmore University',
    egerton: 'Egerton University',
    mmust: 'Masinde Muliro University'
};

/* Tracks which level chip (university / tvet / college) is
   currently active in the My Campus picker. */
let myCampusSelectedLevel = '';

/**
 * Fills the institution <select> with every institution at the
 * given level (from SAMPLE_INSTITUTIONS), A-Z. With no level
 * chosen yet, the dropdown is cleared and disabled.
 */
function populateMyCampusInstitutions(level) {
    const select = document.getElementById('myCampusSelect');
    if (!select) return;

    select.innerHTML = '';

    if (!level) {
        select.disabled = true;

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a level first...';
        select.appendChild(placeholder);
        return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select your institution...';
    select.appendChild(placeholder);

    SAMPLE_INSTITUTIONS
        .filter(function (inst) { return inst.type === level; })
        .slice()
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (inst) {
            const opt = document.createElement('option');
            opt.value = getInstitutionKey(inst);
            opt.textContent = inst.name;
            select.appendChild(opt);
        });

    select.disabled = false;
}

/**
 * Sets the active level chip and refills the institution
 * dropdown to show only institutions at that level.
 */
function setMyCampusLevel(level, buttonEl) {
    myCampusSelectedLevel = level;

    document.querySelectorAll('#myCampusLevel .filter-chip').forEach(function (chip) {
        chip.classList.remove('active');
    });
    if (buttonEl) buttonEl.classList.add('active');

    populateMyCampusInstitutions(level);
}

/**
 * Builds the News / Announcements / Opportunities card grid
 * shown once a campus is chosen, each card carrying the
 * institution key so category.html can filter by it. Shared
 * with the institution chooser popup further down this file.
 */
function renderChoiceGrid(container, institutionKey, institutionName) {
    if (!container) return;

    container.innerHTML = '';

    const hasOfficialSite = Boolean(INSTITUTION_OFFICIAL_SITES[institutionKey]);

    INSTITUTION_CHOICES.forEach(function (choice) {
        const a = document.createElement('a');
        a.className = 'opportunity-card ' + choice.accent;

        if (choice.external) {
            /* News and Announcements: no internal aggregator ever
               covers a single institution, so send each to a
               search scoped to that institution's OWN site,
               filtered to news vs. announcements respectively. */
            /* Same-tab navigation on purpose: opening a new tab
               would leave it with no history to go "back" through,
               so pressing back wouldn't return to the app. */
            a.href = getInstitutionOfficialUrl(institutionKey, institutionName, choice.kind);
        } else {
            /* Opportunities: HigherSpace Connect's own nationwide
               scholarships/jobs feed, which does have real data. */
            a.href = 'category.html?type=' + encodeURIComponent(choice.type) +
                '&institution=' + encodeURIComponent(institutionKey) +
                '&name=' + encodeURIComponent(institutionName || '');
        }

        const icon = document.createElement('span');
        icon.className = 'opportunity-icon';
        icon.textContent = choice.icon;

        const h3 = document.createElement('h3');
        h3.textContent = choice.label;

        const p = document.createElement('p');
        p.textContent = choice.text;

        a.appendChild(icon);
        a.appendChild(h3);
        a.appendChild(p);

        if (choice.external && !hasOfficialSite) {
            const note = document.createElement('span');
            note.className = 'opportunity-card-note';
            note.textContent = 'We\u2019ll search for their site \u2192';
            a.appendChild(note);
        }

        container.appendChild(a);
    });
}

function buildMyCampusLinks(institutionKey, institutionName) {
    renderChoiceGrid(document.getElementById('myCampusLinks'), institutionKey, institutionName);
}

/**
 * Shows the "My Campus" result panel for the given institution
 * key and hides the picker.
 */
function renderMyCampus(institutionKey) {
    const picker = document.getElementById('myCampusPicker');
    const result = document.getElementById('myCampusResult');
    const nameEl = document.getElementById('myCampusName');

    const inst = SAMPLE_INSTITUTIONS.find(function (i) { return getInstitutionKey(i) === institutionKey; });
    const name = inst ? inst.name : MY_CAMPUS_INSTITUTIONS[institutionKey];
    if (!name || !picker || !result || !nameEl) return;

    nameEl.textContent = name;
    buildMyCampusLinks(institutionKey, name);

    picker.hidden = true;
    result.hidden = false;
}

/**
 * Reads the selected institution from the dropdown, saves it
 * (with its level) and shows the personalized card grid.
 */
function setMyCampus() {
    const select = document.getElementById('myCampusSelect');
    if (!select || !select.value) {
        if (select) select.focus();
        return;
    }

    const inst = SAMPLE_INSTITUTIONS.find(function (i) { return getInstitutionKey(i) === select.value; });
    const level = inst ? inst.type : myCampusSelectedLevel;

    try {
        localStorage.setItem(MY_CAMPUS_STORAGE_KEY, JSON.stringify({
            key: select.value,
            level: level
        }));
    } catch (err) {
        /* Private browsing / storage disabled — still show the
           panel for this visit even if it won't persist. */
    }

    renderMyCampus(select.value);
}

/**
 * Clears the saved institution and level, and shows the picker
 * again from step 1.
 */
function clearMyCampus() {
    try {
        localStorage.removeItem(MY_CAMPUS_STORAGE_KEY);
    } catch (err) {
        /* Ignore — nothing to clear if storage isn't available. */
    }

    const picker = document.getElementById('myCampusPicker');
    const result = document.getElementById('myCampusResult');
    const select = document.getElementById('myCampusSelect');

    if (result) result.hidden = true;
    if (picker) picker.hidden = false;
    if (select) select.value = '';

    myCampusSelectedLevel = '';
    document.querySelectorAll('#myCampusLevel .filter-chip').forEach(function (chip) {
        chip.classList.remove('active');
    });
    populateMyCampusInstitutions('');
}

/* On load, restore a previously saved level + campus, if any. */
document.addEventListener('DOMContentLoaded', function () {
    populateMyCampusInstitutions('');

    let saved = null;
    try {
        saved = localStorage.getItem(MY_CAMPUS_STORAGE_KEY);
    } catch (err) {
        saved = null;
    }

    if (!saved) return;

    let data;
    try {
        data = JSON.parse(saved);
    } catch (err) {
        /* Legacy value from before levels existed: a bare
           institution key string. */
        data = { key: saved, level: '' };
    }

    if (!data || !data.key) return;

    const inst = SAMPLE_INSTITUTIONS.find(function (i) { return getInstitutionKey(i) === data.key; });
    const level = data.level || (inst ? inst.type : '');
    const name = inst ? inst.name : MY_CAMPUS_INSTITUTIONS[data.key];

    if (!name) return;

    if (level) {
        populateMyCampusInstitutions(level);
        myCampusSelectedLevel = level;

        const chip = document.querySelector('#myCampusLevel .filter-chip[data-level="' + level + '"]');
        if (chip) chip.classList.add('active');
    }

    const select = document.getElementById('myCampusSelect');
    if (select) select.value = data.key;

    renderMyCampus(data.key);
});

/* On institutions.html load: read q/type/county from the URL
   (set by the homepage search box) and pre-fill + filter. */
document.addEventListener('DOMContentLoaded', function () {
    const grid = document.getElementById('institutionsResultsGrid');
    if (!grid) return;

    const params = new URLSearchParams(window.location.search);
    const q = params.get('q') || '';
    const type = params.get('type') || 'all';
    const county = params.get('county') || '';

    const searchInput = document.getElementById('institutionsPageSearchInput');
    const countySelect = document.getElementById('institutionsPageCounty');

    if (searchInput) searchInput.value = q;
    if (countySelect) countySelect.value = county;

    institutionsPageFilter = type;
    document.querySelectorAll('#institutionsPageFilters .filter-chip').forEach(function (chip) {
        chip.classList.toggle('active', chip.getAttribute('data-filter') === type);
    });

    filterInstitutionsPage();

    if (searchInput) {
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                filterInstitutionsPage();
            }
        });
    }
});


/* =====================================================
   INSTITUTIONS DIRECTORY PAGE (institutions.html)
   Placeholder sample data — swap SAMPLE_INSTITUTIONS for
   a real data source (API/CMS) when one is available.
===================================================== */

const SAMPLE_INSTITUTIONS = [
    { name: 'University of Nairobi', type: 'university', county: 'nairobi' },
    { name: 'Kenyatta University', type: 'university', county: 'kiambu' },
    { name: 'JKUAT', type: 'university', county: 'kiambu' },
    { name: 'Moi University', type: 'university', county: 'uasin-gishu' },
    { name: 'Strathmore University', type: 'university', county: 'nairobi' },
    { name: 'Egerton University', type: 'university', county: 'nakuru' },
    { name: 'Maseno University', type: 'university', county: 'kisumu' },

    /* --- Public universities --- */
    { name: 'Technical University of Kenya', type: 'university', county: 'nairobi' },
    { name: 'Multimedia University of Kenya', type: 'university', county: 'nairobi' },
    { name: 'Cooperative University of Kenya', type: 'university', county: 'nairobi' },
    { name: 'Dedan Kimathi University of Technology', type: 'university', county: 'nyeri' },
    { name: 'Karatina University', type: 'university', county: 'nyeri' },
    { name: 'Chuka University', type: 'university', county: 'tharaka-nithi' },
    { name: 'Kisii University', type: 'university', county: 'kisii' },
    { name: 'Laikipia University', type: 'university', county: 'laikipia' },
    { name: 'South Eastern Kenya University', type: 'university', county: 'kitui' },
    { name: 'Masinde Muliro University of Science and Technology', type: 'university', county: 'kakamega' },
    { name: 'Pwani University', type: 'university', county: 'kilifi' },
    { name: 'Kibabii University', type: 'university', county: 'bungoma' },
    { name: 'Machakos University', type: 'university', county: 'machakos' },
    { name: 'Meru University of Science and Technology', type: 'university', county: 'meru' },
    { name: "Murang'a University of Technology", type: 'university', county: 'muranga' },
    { name: 'Rongo University', type: 'university', county: 'migori' },
    { name: 'Taita Taveta University', type: 'university', county: 'taita-taveta' },
    { name: 'University of Eldoret', type: 'university', county: 'uasin-gishu' },
    { name: 'University of Kabianga', type: 'university', county: 'kericho' },
    { name: 'Jaramogi Oginga Odinga University of Science and Technology', type: 'university', county: 'siaya' },
    { name: 'Garissa University', type: 'university', county: 'garissa' },
    { name: 'Tom Mboya University', type: 'university', county: 'homa-bay' },
    { name: 'Alupe University', type: 'university', county: 'busia' },
    { name: 'Turkana University College', type: 'university', county: 'turkana' },
    { name: 'Koitaleel Samoei University College', type: 'university', county: 'nandi' },
    { name: 'Bomet University College', type: 'university', county: 'bomet' },
    { name: 'Kaimosi Friends University', type: 'university', county: 'vihiga' },
    { name: 'Kirinyaga University', type: 'university', county: 'kirinyaga' },
    { name: 'University of Embu', type: 'university', county: 'embu' },
    { name: 'Maasai Mara University', type: 'university', county: 'narok' },

    /* --- Private chartered universities --- */
    { name: 'Catholic University of Eastern Africa', type: 'university', county: 'nairobi' },
    { name: 'United States International University Africa', type: 'university', county: 'nairobi' },
    { name: 'Daystar University', type: 'university', county: 'machakos' },
    { name: 'Africa Nazarene University', type: 'university', county: 'kajiado' },
    { name: 'Pan Africa Christian University', type: 'university', county: 'nairobi' },
    { name: "St. Paul's University", type: 'university', county: 'kiambu' },
    { name: 'Kenya Highlands Evangelical University', type: 'university', county: 'kericho' },
    { name: 'University of Eastern Africa, Baraton', type: 'university', county: 'nandi' },
    { name: 'Kabarak University', type: 'university', county: 'nakuru' },
    { name: 'Mount Kenya University', type: 'university', county: 'kiambu' },
    { name: 'Zetech University', type: 'university', county: 'kiambu' },
    { name: 'KCA University', type: 'university', county: 'nairobi' },
    { name: 'Riara University', type: 'university', county: 'nairobi' },
    { name: 'Presbyterian University of East Africa', type: 'university', county: 'kiambu' },
    { name: 'Africa International University', type: 'university', county: 'nairobi' },
    { name: 'Gretsa University', type: 'university', county: 'kiambu' },
    { name: 'Management University of Africa', type: 'university', county: 'nairobi' },
    { name: 'Great Lakes University of Kisumu', type: 'university', county: 'kisumu' },
    { name: 'Pioneer International University', type: 'university', county: 'nairobi' },
    { name: 'Lukenya University', type: 'university', county: 'machakos' },
    { name: 'Umma University', type: 'university', county: 'kajiado' },
    { name: 'Amref International University', type: 'university', county: 'nairobi' },
    { name: 'Uzima University', type: 'university', county: 'kisumu' },
    { name: 'Kenya Methodist University', type: 'university', county: 'meru' },
    { name: 'Adventist University of Africa', type: 'university', county: 'nairobi' },
    { name: 'Scott Christian University', type: 'university', county: 'machakos' },

    { name: 'Technical University of Mombasa', type: 'tvet', county: 'mombasa' },
    { name: 'Kisumu National Polytechnic', type: 'tvet', county: 'kisumu' },
    { name: 'Nakuru National Polytechnic', type: 'tvet', county: 'nakuru' },
    { name: 'Rift Valley Institute of Science and Technology', type: 'tvet', county: 'uasin-gishu' },

    /* --- National Polytechnics --- */
    { name: 'Kenya Coast National Polytechnic', type: 'tvet', county: 'mombasa' },
    { name: 'Eldoret National Polytechnic', type: 'tvet', county: 'uasin-gishu' },
    { name: 'Meru National Polytechnic', type: 'tvet', county: 'meru' },
    { name: 'North Eastern National Polytechnic', type: 'tvet', county: 'garissa' },
    { name: 'Sigalagala National Polytechnic', type: 'tvet', county: 'kakamega' },
    { name: 'Kitale National Polytechnic', type: 'tvet', county: 'trans-nzoia' },
    { name: 'Kabete National Polytechnic', type: 'tvet', county: 'nairobi' },
    { name: 'Nyeri National Polytechnic', type: 'tvet', county: 'nyeri' },
    { name: 'Kisii National Polytechnic', type: 'tvet', county: 'kisii' },
    { name: 'Kabarnet National Polytechnic', type: 'tvet', county: 'baringo' },
    { name: 'Nyandarua National Polytechnic', type: 'tvet', county: 'nyandarua' },
    { name: 'Kericho National Polytechnic', type: 'tvet', county: 'kericho' },

    /* --- Technical Training Institutes --- */
    { name: 'Thika Technical Training Institute', type: 'tvet', county: 'kiambu' },
    { name: 'Kaiboi Technical Training Institute', type: 'tvet', county: 'uasin-gishu' },
    { name: 'Bumbe Technical Training Institute', type: 'tvet', county: 'busia' },
    { name: 'Baringo Technical College', type: 'tvet', county: 'baringo' },
    { name: 'Siaya Institute of Technology', type: 'tvet', county: 'siaya' },
    { name: 'Kilifi Institute of Technology', type: 'tvet', county: 'kilifi' },
    { name: 'Voi Technical Training Institute', type: 'tvet', county: 'taita-taveta' },
    { name: 'Garissa Technical Training Institute', type: 'tvet', county: 'garissa' },
    { name: 'Wote Technical Training Institute', type: 'tvet', county: 'makueni' },
    { name: 'Kitui Technical Training Institute', type: 'tvet', county: 'kitui' },
    { name: 'Machakos Technical Training Institute', type: 'tvet', county: 'machakos' },
    { name: 'Nairobi Technical Training Institute', type: 'tvet', county: 'nairobi' },
    { name: 'Bureti Technical Training Institute', type: 'tvet', county: 'kericho' },
    { name: "Murang'a Technical Training Institute", type: 'tvet', county: 'muranga' },
    { name: 'Kigumo Technical Training Institute', type: 'tvet', county: 'muranga' },
    { name: 'Kaimosi Friends Technical Training Institute', type: 'tvet', county: 'vihiga' },
    { name: 'Kabianga Technical Training Institute', type: 'tvet', county: 'kericho' },
    { name: 'Kandara Technical Training Institute', type: 'tvet', county: 'muranga' },
    { name: 'Kaigat Technical Training Institute', type: 'tvet', county: 'baringo' },
    { name: 'Chuka Technical Training Institute', type: 'tvet', county: 'tharaka-nithi' },
    { name: 'Kigari Teachers Training Institute', type: 'tvet', county: 'embu' },
    { name: 'Kabete Technical Training Institute for the Deaf', type: 'tvet', county: 'nairobi' },
    { name: 'Kaimosi Technical Training Institute', type: 'tvet', county: 'vihiga' },
    { name: 'Ramogi Institute of Advanced Technology', type: 'tvet', county: 'kisumu' },
    { name: 'Bushiangala Technical Training Institute', type: 'tvet', county: 'kakamega' },
    { name: 'Kisiwa Technical Training Institute', type: 'tvet', county: 'homa-bay' },
    { name: 'Kaplong Technical Training Institute', type: 'tvet', county: 'bomet' },
    { name: 'Litein Technical Training Institute', type: 'tvet', county: 'kericho' },
    { name: 'Nyandarua Institute of Science and Technology', type: 'tvet', county: 'nyandarua' },
    { name: 'Rift Valley Technical Training Institute', type: 'tvet', county: 'nakuru' },
    { name: 'Sotik Technical Training Institute', type: 'tvet', county: 'bomet' },
    { name: 'Kabarnet Technical Training Institute', type: 'tvet', county: 'baringo' },

    { name: 'Nairobi Institute of Business Studies', type: 'college', county: 'nairobi' },
    { name: 'Mombasa College of Health Sciences', type: 'college', county: 'mombasa' },
    { name: 'Kisumu College of Technology', type: 'college', county: 'kisumu' },

    /* --- Kenya Medical Training College (KMTC) campuses --- */
    { name: 'KMTC Nairobi Campus', type: 'college', county: 'nairobi' },
    { name: 'KMTC Nakuru Campus', type: 'college', county: 'nakuru' },
    { name: 'KMTC Eldoret Campus', type: 'college', county: 'uasin-gishu' },
    { name: 'KMTC Meru Campus', type: 'college', county: 'meru' },
    { name: 'KMTC Kakamega Campus', type: 'college', county: 'kakamega' },
    { name: 'KMTC Embu Campus', type: 'college', county: 'embu' },
    { name: 'KMTC Garissa Campus', type: 'college', county: 'garissa' },
    { name: 'KMTC Kisii Campus', type: 'college', county: 'kisii' },
    { name: 'KMTC Machakos Campus', type: 'college', county: 'machakos' },
    { name: 'KMTC Nyeri Campus', type: 'college', county: 'nyeri' },
    { name: 'KMTC Kitale Campus', type: 'college', county: 'trans-nzoia' },
    { name: 'KMTC Kericho Campus', type: 'college', county: 'kericho' },
    { name: 'KMTC Bungoma Campus', type: 'college', county: 'bungoma' },
    { name: 'KMTC Kilifi Campus', type: 'college', county: 'kilifi' },
    { name: 'KMTC Lodwar Campus', type: 'college', county: 'turkana' },
    { name: 'KMTC Wajir Campus', type: 'college', county: 'wajir' },
    { name: 'KMTC Nyahururu Campus', type: 'college', county: 'laikipia' },
    { name: "KMTC Murang'a Campus", type: 'college', county: 'muranga' },
    { name: 'KMTC Kabarnet Campus', type: 'college', county: 'baringo' },
    { name: 'KMTC Kitui Campus', type: 'college', county: 'kitui' },
    { name: 'KMTC Homa Bay Campus', type: 'college', county: 'homa-bay' },
    { name: 'KMTC Migori Campus', type: 'college', county: 'migori' },
    { name: 'KMTC Siaya Campus', type: 'college', county: 'siaya' },
    { name: 'KMTC Busia Campus', type: 'college', county: 'busia' },

    /* --- Teacher Training Colleges --- */
    { name: 'Kenya Technical Trainers College', type: 'college', county: 'nairobi' },
    { name: 'Machakos Teachers Training College', type: 'college', county: 'machakos' },
    { name: 'Kagumo Teachers Training College', type: 'college', county: 'nyeri' },
    { name: 'Kilimambogo Teachers Training College', type: 'college', county: 'kiambu' },
    { name: 'Egoji Teachers Training College', type: 'college', county: 'meru' },
    { name: 'Kigari Teachers Training College', type: 'college', county: 'embu' },
    { name: 'Migori Teachers Training College', type: 'college', county: 'migori' },
    { name: 'Shanzu Teachers Training College', type: 'college', county: 'mombasa' },
    { name: 'Baringo Teachers Training College', type: 'college', county: 'baringo' },
    { name: 'Garissa Teachers Training College', type: 'college', county: 'garissa' },
    { name: 'Siriba Teachers Training College', type: 'college', county: 'kisumu' },
    { name: 'Kaimosi Teachers Training College', type: 'college', county: 'vihiga' },
    { name: 'Highridge Teachers Training College', type: 'college', county: 'nairobi' },
    { name: "St Joseph's Teachers Training College", type: 'college', county: 'nyeri' },
    { name: 'Bondo Teachers Training College', type: 'college', county: 'siaya' },
    { name: 'Kericho Teachers Training College', type: 'college', county: 'kericho' },
    { name: 'Narok Teachers Training College', type: 'college', county: 'narok' },
    { name: 'Asumbi Teachers Training College', type: 'college', county: 'homa-bay' },

    /* --- Business & other colleges --- */
    { name: 'Kenya Institute of Management', type: 'college', county: 'nairobi' },
    { name: 'Rift Valley Business College', type: 'college', county: 'nakuru' },
    { name: 'Mombasa Business College', type: 'college', county: 'mombasa' },
    { name: 'Eldoret Business and Technical College', type: 'college', county: 'uasin-gishu' },
    { name: 'Nakuru College of Health Sciences', type: 'college', county: 'nakuru' },
    { name: 'Kisumu Business College', type: 'college', county: 'kisumu' },
    { name: 'Thika School of Medical and Health Sciences', type: 'college', county: 'kiambu' }
];

const INSTITUTION_TYPE_LABELS = {
    university: 'University',
    tvet: 'TVET',
    college: 'College'
};

const INSTITUTION_COUNTY_LABELS = {
    mombasa: 'Mombasa',
    kwale: 'Kwale',
    kilifi: 'Kilifi',
    'tana-river': 'Tana River',
    lamu: 'Lamu',
    'taita-taveta': 'Taita-Taveta',
    garissa: 'Garissa',
    wajir: 'Wajir',
    mandera: 'Mandera',
    marsabit: 'Marsabit',
    isiolo: 'Isiolo',
    meru: 'Meru',
    'tharaka-nithi': 'Tharaka-Nithi',
    embu: 'Embu',
    kitui: 'Kitui',
    machakos: 'Machakos',
    makueni: 'Makueni',
    nyandarua: 'Nyandarua',
    nyeri: 'Nyeri',
    kirinyaga: 'Kirinyaga',
    muranga: "Murang'a",
    kiambu: 'Kiambu',
    turkana: 'Turkana',
    'west-pokot': 'West Pokot',
    samburu: 'Samburu',
    'trans-nzoia': 'Trans Nzoia',
    'uasin-gishu': 'Uasin Gishu',
    'elgeyo-marakwet': 'Elgeyo-Marakwet',
    nandi: 'Nandi',
    baringo: 'Baringo',
    laikipia: 'Laikipia',
    nakuru: 'Nakuru',
    narok: 'Narok',
    kajiado: 'Kajiado',
    kericho: 'Kericho',
    bomet: 'Bomet',
    kakamega: 'Kakamega',
    vihiga: 'Vihiga',
    bungoma: 'Bungoma',
    busia: 'Busia',
    siaya: 'Siaya',
    kisumu: 'Kisumu',
    'homa-bay': 'Homa Bay',
    migori: 'Migori',
    kisii: 'Kisii',
    nyamira: 'Nyamira',
    nairobi: 'Nairobi'
};


/* =====================================================
   OFFICIAL INSTITUTION SOURCES
   HigherSpace Connect's own News/Announcements feed (see
   ai-updater.js) only ever aggregates NATIONWIDE sources —
   HELB, KUCCPS, CUE, UASU, national press — it has no per-
   institution data of its own, and "News" was never a
   category the AI engine generates at all. So instead of
   pointing students at an internal page that can never have
   anything for their specific institution, each institution
   here is mapped to its own official website: that's where
   its real news and announcements actually get published.
   Keys match getInstitutionKey()'s output. Any institution
   NOT listed here falls back to a web search for its site
   (see getInstitutionOfficialUrl) rather than a guessed URL.
===================================================== */
const INSTITUTION_OFFICIAL_SITES = {
    uon: 'https://www.uonbi.ac.ke',
    ku: 'https://www.ku.ac.ke',
    jkuat: 'https://www.jkuat.ac.ke',
    moi: 'https://www.mu.ac.ke',
    strathmore: 'https://www.strathmore.edu',
    egerton: 'https://www.egerton.ac.ke',
    'maseno-university': 'https://www.maseno.ac.ke',
    'technical-university-of-kenya': 'https://www.tukenya.ac.ke',
    'multimedia-university-of-kenya': 'https://www.mmu.ac.ke',
    'cooperative-university-of-kenya': 'https://www.cuk.ac.ke',
    'dedan-kimathi-university-of-technology': 'https://www.dkut.ac.ke',
    'karatina-university': 'https://www.karu.ac.ke',
    'chuka-university': 'https://www.chuka.ac.ke',
    'kisii-university': 'https://www.kisiiuniversity.ac.ke',
    'laikipia-university': 'https://www.laikipia.ac.ke',
    'south-eastern-kenya-university': 'https://www.seku.ac.ke',
    'masinde-muliro-university-of-science-and-technology': 'https://www.mmust.ac.ke',
    'pwani-university': 'https://www.pu.ac.ke',
    'kibabii-university': 'https://www.kibu.ac.ke',
    'machakos-university': 'https://www.mksu.ac.ke',
    'meru-university-of-science-and-technology': 'https://www.must.ac.ke',
    "murang-a-university-of-technology": 'https://www.mut.ac.ke',
    'university-of-eldoret': 'https://www.uoeld.ac.ke',
    'university-of-kabianga': 'https://www.kabianga.ac.ke',
    'jaramogi-oginga-odinga-university-of-science-and-technology': 'https://www.jooust.ac.ke',
    'university-of-embu': 'https://www.embuni.ac.ke',
    'maasai-mara-university': 'https://www.mmarau.ac.ke',
    'catholic-university-of-eastern-africa': 'https://www.cuea.edu',
    'united-states-international-university-africa': 'https://www.usiu.ac.ke',
    'daystar-university': 'https://www.daystar.ac.ke',
    'africa-nazarene-university': 'https://www.anu.ac.ke',
    'kabarak-university': 'https://www.kabarak.ac.ke',
    'mount-kenya-university': 'https://www.mku.ac.ke',
    'zetech-university': 'https://www.zetech.ac.ke',
    'riara-university': 'https://www.riarauniversity.ac.ke',
    'taita-taveta-university': 'https://www.ttu.ac.ke',
    'technical-university-of-mombasa': 'https://www.tum.ac.ke'
};

/**
 * Returns where a student should go for this institution's OWN
 * news or its OWN announcements — two different destinations,
 * not the same homepage for both.
 *
 * We don't have (and can't reliably guess) each institution's
 * exact "/news" or "/announcements" page — those paths differ
 * site to site and change over time, so hardcoding them would
 * mean quietly-broken links down the road. Instead, for any
 * institution whose official domain we DO have on file, this
 * runs a Google search scoped to that domain (site:...) with
 * terms matching the kind requested, so News and Announcements
 * genuinely return different, institution-only results. With no
 * confirmed domain, it falls back to the same kind of search
 * using the institution's name instead of a site: filter.
 *
 * kind: 'news' | 'announcements'
 */
function getInstitutionOfficialUrl(institutionKey, institutionName, kind) {
    const terms = kind === 'announcements'
        ? 'announcements OR notices OR circular'
        : 'news OR "latest news"';

    const site = INSTITUTION_OFFICIAL_SITES[institutionKey];

    if (site) {
        const domain = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
        return 'https://www.google.com/search?q=' +
            encodeURIComponent('site:' + domain + ' ' + terms);
    }

    return 'https://www.google.com/search?q=' +
        encodeURIComponent((institutionName || institutionKey) + ' official ' + terms);
}

let institutionsPageFilter = 'all';

/**
 * Sets the active type filter chip on institutions.html and
 * re-runs the filter.
 */
function setInstitutionsPageFilter(filter, buttonEl) {
    institutionsPageFilter = filter;

    document.querySelectorAll('#institutionsPageFilters .filter-chip').forEach(function (chip) {
        chip.classList.remove('active');
    });

    if (buttonEl) {
        buttonEl.classList.add('active');
    }

    filterInstitutionsPage();
}

/**
 * Filters SAMPLE_INSTITUTIONS by the search box, active type
 * chip, and county dropdown, then renders the result cards.
 * No-ops safely if the results grid isn't on the page.
 */
function filterInstitutionsPage() {
    const grid = document.getElementById('institutionsResultsGrid');
    if (!grid) return;

    const searchInput = document.getElementById('institutionsPageSearchInput');
    const countySelect = document.getElementById('institutionsPageCounty');
    const countEl = document.getElementById('institutionsResultCount');
    const emptyEl = document.getElementById('institutionsEmpty');

    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const county = countySelect ? countySelect.value : '';

    const results = SAMPLE_INSTITUTIONS.filter(function (inst) {
        if (institutionsPageFilter !== 'all' && inst.type !== institutionsPageFilter) return false;
        if (county && inst.county !== county) return false;
        if (query && inst.name.toLowerCase().indexOf(query) === -1) return false;
        return true;
    });

    grid.innerHTML = '';

    results.forEach(function (inst) {
        const card = document.createElement('div');
        card.className = 'institution-result-card cat-' + inst.type;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', 'Choose news, announcements or opportunities for ' + inst.name);
        card.addEventListener('click', function () { openInstitutionChooser(inst.name); });
        card.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openInstitutionChooser(inst.name);
            }
        });

        const tag = document.createElement('span');
        tag.className = 'institution-result-tag';
        tag.textContent = INSTITUTION_TYPE_LABELS[inst.type] || inst.type;

        const heading = document.createElement('h3');
        heading.textContent = inst.name;

        const location = document.createElement('p');
        location.textContent = INSTITUTION_COUNTY_LABELS[inst.county] || inst.county;

        card.appendChild(tag);
        card.appendChild(heading);
        card.appendChild(location);
        grid.appendChild(card);
    });

    if (countEl) {
        countEl.textContent = results.length +
            (results.length === 1 ? ' institution found' : ' institutions found');
    }

    if (emptyEl) {
        emptyEl.hidden = results.length !== 0;
    }
}


/* =====================================================
   INSTITUTION CHOOSER (popup)
   Clicking any institution opens a popup asking whether the
   student wants News, Announcements or Opportunities for
   THAT institution. Works on any page: give a link/element
   a data-institution="Full Institution Name" attribute, or
   call openInstitutionChooser('Name').
===================================================== */

function getInstitutionKey(inst) {
    for (const key in MY_CAMPUS_INSTITUTIONS) {
        if (MY_CAMPUS_INSTITUTIONS[key] === inst.name) return key;
    }

    return inst.name
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const INSTITUTION_CHOICES = [
    { label: 'News', icon: '📰', accent: 'cat-news', kind: 'news',
      text: "Latest stories, from the institution's own site.", external: true },
    { label: 'Announcements', icon: '📢', accent: 'cat-announcements', kind: 'announcements',
      text: "Official notices and circulars, from the institution's own site.", external: true },
    { label: 'Opportunities', icon: '💰', type: 'scholarships', accent: 'cat-scholarships',
      text: 'Scholarships, jobs and more.' }
];

function closeInstitutionChooser() {
    const overlay = document.getElementById('institutionChooser');
    if (overlay) overlay.remove();
    document.body.classList.remove('chooser-open');
}

function openInstitutionChooser(name) {
    closeInstitutionChooser();

    const inst = SAMPLE_INSTITUTIONS.find(function (i) { return i.name === name; }) ||
        { name: name, type: '', county: '' };
    const key = getInstitutionKey(inst);

    const overlay = document.createElement('div');
    overlay.id = 'institutionChooser';
    overlay.className = 'chooser-overlay';
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeInstitutionChooser();
    });

    const box = document.createElement('div');
    box.className = 'chooser-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chooser-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', closeInstitutionChooser);

    const title = document.createElement('h2');
    title.textContent = inst.name;

    const sub = document.createElement('p');
    sub.textContent = 'What would you like to see?';

    const grid = document.createElement('div');
    grid.className = 'chooser-options';
    renderChoiceGrid(grid, key, inst.name);

    box.appendChild(close);
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(grid);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.body.classList.add('chooser-open');
}

/* Close on Escape. */
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeInstitutionChooser();
});

/* Any element with data-institution opens the chooser
   (used by the homepage "Most Searched Institutions" list). */
document.addEventListener('click', function (e) {
    const el = e.target.closest ? e.target.closest('[data-institution]') : null;
    if (!el) return;
    e.preventDefault();
    openInstitutionChooser(el.getAttribute('data-institution'));
});


/* =====================================================
   POPULAR COURSES — info modal
   Tapping a course chip on the homepage shows a quick
   overview (what it covers, typical duration, career
   paths) instead of immediately leaving the page. The
   modal still links through to the existing category.html
   listing for that field.
===================================================== */

const COURSES_DATA = {
    'computer-science': {
        label: 'Computer Science',
        icon: '💻',
        duration: 'Usually 4 years',
        blurb: 'Focuses on programming, algorithms, software development, databases and the theory behind how computers work.',
        careers: ['Software Developer', 'Systems Analyst', 'Data Analyst', 'IT Consultant']
    },
    'cybersecurity': {
        label: 'Cybersecurity',
        icon: '🔐',
        duration: 'Usually 4 years',
        blurb: 'Covers network security, ethical hacking, digital forensics and how to protect systems and data from cyber threats.',
        careers: ['Security Analyst', 'Penetration Tester', 'SOC Analyst', 'IT Auditor']
    },
    'business': {
        label: 'Business',
        icon: '📊',
        duration: 'Usually 4 years',
        blurb: 'A broad foundation in management, marketing, accounting and entrepreneurship for running or working in organizations.',
        careers: ['Business Analyst', 'Marketing Officer', 'Entrepreneur', 'Operations Manager']
    },
    'nursing': {
        label: 'Nursing',
        icon: '🩺',
        duration: 'Typically 4 years',
        blurb: 'Trains students in patient care, clinical procedures, public health and healthcare management.',
        careers: ['Registered Nurse', 'Nurse Educator', 'Public Health Officer', 'Clinical Officer']
    },
    'engineering': {
        label: 'Engineering',
        icon: '⚙️',
        duration: 'Typically 5 years',
        blurb: 'Covers the design, analysis and maintenance of structures, machines, electrical systems or processes. Branches include civil, mechanical, electrical and more.',
        careers: ['Design Engineer', 'Site Engineer', 'Project Manager', 'Systems Engineer']
    },
    'education': {
        label: 'Education',
        icon: '🍎',
        duration: 'Usually 4 years',
        blurb: 'Prepares students to teach, covering pedagogy, curriculum development and a chosen teaching subject.',
        careers: ['Secondary School Teacher', 'Curriculum Developer', 'Education Officer', 'Instructional Designer']
    },
    'law': {
        label: 'Law',
        icon: '⚖️',
        duration: 'Usually 4 years, plus the Kenya School of Law diploma before admission to the bar',
        blurb: 'Covers legal theory, the Kenyan legal system, contracts, criminal law and litigation, leading to the LLB.',
        careers: ['Advocate', 'Legal Officer', 'Corporate Counsel', 'Magistrate (after further training)']
    },
    'medicine': {
        label: 'Medicine & Surgery',
        icon: '🩻',
        duration: 'Typically 5-6 years, plus a mandatory internship',
        blurb: 'Trains doctors to diagnose and treat illness, covering anatomy, physiology, pharmacology and clinical practice.',
        careers: ['Medical Doctor', 'Surgeon (after specialization)', 'Medical Researcher', 'Public Health Physician']
    },
    'information-technology': {
        label: 'Information Technology',
        icon: '🖥️',
        duration: 'Usually 4 years',
        blurb: 'Focuses on applying computing to business and organizational needs — networks, systems support and IT infrastructure.',
        careers: ['IT Support Specialist', 'Network Administrator', 'Systems Administrator', 'Business Systems Analyst']
    },
    'software-engineering': {
        label: 'Software Engineering',
        icon: '🧑\u200d💻',
        duration: 'Usually 4 years',
        blurb: 'A more structured, engineering-focused approach to building, testing and maintaining large software systems.',
        careers: ['Software Engineer', 'DevOps Engineer', 'QA Engineer', 'Technical Lead']
    },
    'data-science': {
        label: 'Data Science',
        icon: '📈',
        duration: 'Usually 4 years',
        blurb: 'Combines statistics, programming and machine learning to find patterns and insight in data.',
        careers: ['Data Scientist', 'Data Analyst', 'Machine Learning Engineer', 'Business Intelligence Analyst']
    },
    'actuarial-science': {
        label: 'Actuarial Science',
        icon: '🧮',
        duration: 'Usually 4 years',
        blurb: 'Applies mathematics, statistics and financial theory to assess and manage risk, mainly in insurance and finance.',
        careers: ['Actuarial Analyst', 'Risk Analyst', 'Insurance Underwriter', 'Pension Fund Analyst']
    },
    'economics': {
        label: 'Economics',
        icon: '💹',
        duration: 'Usually 4 years',
        blurb: 'Studies how markets, resources and policy decisions affect production, trade and wellbeing.',
        careers: ['Economist', 'Policy Analyst', 'Research Analyst', 'Banking Officer']
    },
    'accounting-finance': {
        label: 'Accounting & Finance',
        icon: '💰',
        duration: 'Usually 4 years',
        blurb: 'Covers financial reporting, auditing, taxation and corporate finance.',
        careers: ['Accountant', 'Auditor', 'Financial Analyst', 'Tax Consultant']
    },
    'pharmacy': {
        label: 'Pharmacy',
        icon: '💊',
        duration: 'Typically 5 years',
        blurb: 'Trains students in drug formulation, dispensing, pharmacology and counselling patients on medication.',
        careers: ['Pharmacist', 'Clinical Pharmacist', 'Pharmaceutical Sales Rep', 'Drug Regulatory Officer']
    },
    'agriculture': {
        label: 'Agriculture',
        icon: '🌾',
        duration: 'Usually 4 years',
        blurb: 'Covers crop and livestock production, agribusiness, soil science and food security.',
        careers: ['Agricultural Officer', 'Agribusiness Manager', 'Agronomist', 'Extension Officer']
    },
    'architecture': {
        label: 'Architecture',
        icon: '🏛️',
        duration: 'Typically 5 years or more, often followed by professional registration',
        blurb: 'Focuses on designing buildings and spaces, blending creativity with structural and technical knowledge.',
        careers: ['Architect (after registration)', 'Urban Designer', 'Interior Designer', 'Construction Project Manager']
    },
    'journalism': {
        label: 'Journalism & Mass Communication',
        icon: '📰',
        duration: 'Usually 4 years',
        blurb: 'Covers news writing, media production, public relations and digital communication.',
        careers: ['Journalist', 'PR Officer', 'Content Creator', 'Broadcast Producer']
    },
    'psychology': {
        label: 'Psychology',
        icon: '🧠',
        duration: 'Usually 4 years',
        blurb: 'Studies human behaviour, mental processes and emotional wellbeing.',
        careers: ['Counselling Psychologist', 'HR Officer', 'Researcher', 'Social Worker']
    },
    'hospitality-tourism': {
        label: 'Hospitality & Tourism Management',
        icon: '🏨',
        duration: 'Usually 4 years',
        blurb: 'Prepares students to manage hotels, travel operations and tourism experiences.',
        careers: ['Hotel Manager', 'Tour Operator', 'Events Manager', 'Airline Customer Service']
    },
    'environmental-science': {
        label: 'Environmental Science',
        icon: '🌍',
        duration: 'Usually 4 years',
        blurb: 'Studies ecosystems, pollution, conservation and sustainable resource management.',
        careers: ['Environmental Officer', 'Conservationist', 'EIA Consultant', 'Sustainability Analyst']
    },
    'public-health': {
        label: 'Public Health',
        icon: '🏥',
        duration: 'Usually 4 years',
        blurb: 'Focuses on disease prevention, health promotion and community health systems.',
        careers: ['Public Health Officer', 'Epidemiologist', 'Health Program Coordinator', 'NGO Health Worker']
    },
    'human-resource-management': {
        label: 'Human Resource Management',
        icon: '🤝',
        duration: 'Usually 4 years',
        blurb: 'Covers recruitment, employee relations, training and organizational development.',
        careers: ['HR Officer', 'Recruitment Specialist', 'Training Coordinator', 'Compensation Analyst']
    },
    'veterinary-medicine': {
        label: 'Veterinary Medicine',
        icon: '🐾',
        duration: 'Typically 5 years',
        blurb: 'Trains veterinarians in animal health, disease diagnosis, surgery and livestock production.',
        careers: ['Veterinary Surgeon', 'Animal Health Officer', 'Livestock Researcher', 'Wildlife Veterinarian']
    }
};

function closeCourseInfo() {
    const overlay = document.getElementById('courseInfoOverlay');
    if (overlay) overlay.remove();
    document.body.classList.remove('chooser-open');
}

function openCourseInfo(key, href) {
    closeCourseInfo();

    const course = COURSES_DATA[key];
    if (!course) {
        /* Unknown course key -- fall back to just navigating,
           same as the old plain link used to. */
        if (href) window.location.href = href;
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'courseInfoOverlay';
    overlay.className = 'chooser-overlay';
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeCourseInfo();
    });

    const box = document.createElement('div');
    box.className = 'chooser-box course-info-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chooser-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', closeCourseInfo);

    const head = document.createElement('div');
    head.className = 'course-info-head';

    const icon = document.createElement('span');
    icon.className = 'course-info-icon';
    icon.textContent = course.icon || '🎓';

    const title = document.createElement('h2');
    title.textContent = course.label;

    head.appendChild(icon);
    head.appendChild(title);

    const duration = document.createElement('span');
    duration.className = 'course-info-duration';
    duration.textContent = course.duration;

    const blurb = document.createElement('p');
    blurb.className = 'course-info-blurb';
    blurb.textContent = course.blurb;

    const subhead = document.createElement('p');
    subhead.className = 'course-info-subhead';
    subhead.textContent = 'What you could become';

    const careersList = document.createElement('ul');
    careersList.className = 'course-info-careers';
    (course.careers || []).forEach(function (career) {
        const li = document.createElement('li');
        li.textContent = career;
        careersList.appendChild(li);
    });

    /* Rather than a single "explore institutions" link, ask which
       level the student wants FIRST - the institutions (and the
       admission criteria shown on category.html) are different
       for a university degree vs. a TVET diploma vs. a college
       diploma/certificate in the same field. */

    const levelSubhead = document.createElement('p');
    levelSubhead.className = 'course-info-subhead';
    levelSubhead.textContent = 'Where would you like to study this?';

    const levelGrid = document.createElement('div');
    levelGrid.className = 'chooser-options course-info-levels';

    const baseHref =
        href ||
        ('category.html?type=courses&field=' + encodeURIComponent(key));

    const hrefHasQuery = baseHref.indexOf('?') !== -1;

    const COURSE_LEVEL_CHOICES = [
        { level: 'university', icon: '🎓', label: 'University',
          text: 'Degree programme, placed through KUCCPS (usually KCSE mean grade C+ and above).' },
        { level: 'tvet', icon: '🛠️', label: 'TVET Institution',
          text: 'Diploma or certificate at a national polytechnic (usually KCSE mean grade C- and above for Diploma).' },
        { level: 'college', icon: '🏫', label: 'College',
          text: 'Diploma or certificate at a specialised college (e.g. KMTC, KIM, Kenya Utalii College).' }
    ];

    COURSE_LEVEL_CHOICES.forEach(function (choice) {
        const a = document.createElement('a');
        a.className = 'opportunity-card';
        a.href = baseHref + (hrefHasQuery ? '&' : '?') + 'level=' + choice.level;

        const icon = document.createElement('span');
        icon.className = 'opportunity-icon';
        icon.textContent = choice.icon;

        const h3 = document.createElement('h3');
        h3.textContent = choice.label;

        const p = document.createElement('p');
        p.textContent = choice.text;

        a.appendChild(icon);
        a.appendChild(h3);
        a.appendChild(p);
        levelGrid.appendChild(a);
    });

    box.appendChild(close);
    box.appendChild(head);
    box.appendChild(duration);
    box.appendChild(blurb);
    box.appendChild(subhead);
    box.appendChild(careersList);
    box.appendChild(levelSubhead);
    box.appendChild(levelGrid);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.body.classList.add('chooser-open');
}

/* Close on Escape. */
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeCourseInfo();
});

/* Any course chip on the homepage opens the info modal
   instead of navigating straight away. */
document.addEventListener('click', function (e) {
    const el = e.target.closest ? e.target.closest('[data-course]') : null;
    if (!el) return;
    openCourseInfo(el.getAttribute('data-course'), el.getAttribute('data-href'));
});