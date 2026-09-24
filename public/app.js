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

/**
 * Builds the row of quick-link pills shown once a campus is
 * chosen (News, Announcements, Opportunities), each carrying
 * the institution key so category.html can filter by it.
 */
function buildMyCampusLinks(institutionKey) {
    const container = document.getElementById('myCampusLinks');
    if (!container) return;

    container.innerHTML = '';

    const links = [
        { label: 'News', type: 'news' },
        { label: 'Announcements', type: 'university-alerts' },
        { label: 'Opportunities', type: 'scholarships' }
    ];

    links.forEach(function (link) {
        const a = document.createElement('a');
        a.href = 'category.html?type=' + encodeURIComponent(link.type) +
            '&institution=' + encodeURIComponent(institutionKey);
        a.textContent = link.label;
        container.appendChild(a);
    });
}

/**
 * Shows the "My Campus" result panel for the given institution
 * key and hides the picker. Pass no argument to just re-render
 * from whatever is already saved.
 */
function renderMyCampus(institutionKey) {
    const picker = document.getElementById('myCampusPicker');
    const result = document.getElementById('myCampusResult');
    const nameEl = document.getElementById('myCampusName');

    const name = MY_CAMPUS_INSTITUTIONS[institutionKey];
    if (!name || !picker || !result || !nameEl) return;

    nameEl.textContent = name;
    buildMyCampusLinks(institutionKey);

    picker.hidden = true;
    result.hidden = false;
}

/**
 * Reads the selected institution from the dropdown, saves it,
 * and shows the personalized panel.
 */
function setMyCampus() {
    const select = document.getElementById('myCampusSelect');
    if (!select || !select.value) {
        if (select) select.focus();
        return;
    }

    try {
        localStorage.setItem(MY_CAMPUS_STORAGE_KEY, select.value);
    } catch (err) {
        /* Private browsing / storage disabled — still show the
           panel for this visit even if it won't persist. */
    }

    renderMyCampus(select.value);
}

/**
 * Clears the saved institution and shows the picker again.
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
}

/* On load, restore a previously saved campus, if any. */
document.addEventListener('DOMContentLoaded', function () {
    let saved = null;

    try {
        saved = localStorage.getItem(MY_CAMPUS_STORAGE_KEY);
    } catch (err) {
        saved = null;
    }

    if (!saved || !MY_CAMPUS_INSTITUTIONS[saved]) return;

    const select = document.getElementById('myCampusSelect');
    if (select) select.value = saved;

    renderMyCampus(saved);
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
    { label: 'News', icon: '📰', type: 'news', accent: 'cat-news',
      text: 'Latest stories and happenings.' },
    { label: 'Announcements', icon: '📢', type: 'university-alerts', accent: 'cat-announcements',
      text: 'Official notices and alerts.' },
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

    INSTITUTION_CHOICES.forEach(function (choice) {
        const a = document.createElement('a');
        a.className = 'opportunity-card ' + choice.accent;
        a.href = 'category.html?type=' + encodeURIComponent(choice.type) +
            '&institution=' + encodeURIComponent(key) +
            '&name=' + encodeURIComponent(inst.name);

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
        grid.appendChild(a);
    });

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