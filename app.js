const SUPABASE_URL = 'https://bbdyylfduesmzwoggced.supabase.co';
        const SUPABASE_KEY = 'sb_publishable_w3iECjE7i0Y2tPtPDAqaAA_pPHDDXVi';
        const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

        const VERIFICATION_API_PRODUCTION_URL = '';
        const VERIFICATION_API_BASE_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
            ? 'http://localhost:3000'
            : VERIFICATION_API_PRODUCTION_URL;

        function maskAccountNo(no) {
            const str = String(no || '');
            const parts = str.split('-');
            if (parts.length < 2) {
                return str.length > 4 ? '*'.repeat(str.length - 4) + str.slice(-4) : str;
            }
            return parts.map((part, i) => {
                if (i === 0) return part;
                if (i === parts.length - 1) return '*'.repeat(Math.max(part.length - 3, 0)) + part.slice(-3);
                return '*'.repeat(part.length);
            }).join('-');
        }

        function pickRpcRow(data) {
            const row = Array.isArray(data) ? data[0] : data;
            if (!row || typeof row !== 'object') return null;
            if (row.ok === false) return null;
            if (!row.id) return null;
            return row;
        }

        const STORAGE_KEY_SESSION = 'kdb_pay_current_user_v2';
        const STORAGE_KEY_MERCHANT_SESSION = 'kdb_pay_current_merchant_v2';

        const STORAGE_KEY_KNOWN_ACCOUNTS = 'kdb_pay_known_accounts_v1';

        const STORAGE_KEY_REMEMBERED_LOGIN = 'kdb_pay_remembered_login_v1';

        function getRememberedLoginUserId() {
            try { return localStorage.getItem(STORAGE_KEY_REMEMBERED_LOGIN) || null; } catch (e) { return null; }
        }

        function rememberLoginUser(id) {
            try {
                localStorage.setItem(STORAGE_KEY_REMEMBERED_LOGIN, id);
                addKnownAccountId(id);
            } catch (e) {}
        }

        function forgetRememberedLoginUser() {
            try { localStorage.removeItem(STORAGE_KEY_REMEMBERED_LOGIN); } catch (e) {}
        }

        function getKnownAccountIds() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEY_KNOWN_ACCOUNTS)) || [];
            } catch (e) {
                return [];
            }
        }

        function addKnownAccountId(id) {
            const ids = getKnownAccountIds();
            if (!ids.includes(id)) {
                ids.push(id);
                localStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(ids));
            }
        }

        const shopProducts = [];

        const defaultMerchants = [
            {
                id: 'mch-1',
                name: 'KDB 성수 디저트 카페',
                category: '카페/디저트',
                bizNo: '128-81-04921',
                accountNo: '110-384-910283',
                unsettledBalance: 0,
                totalSales: 0,
                salesHistory: []
            }
        ];

        const state = {
            users: [],
            hasUsers: false,
            currentUserId: localStorage.getItem(STORAGE_KEY_SESSION) || null,
            sessionToken: null,
            merchantToken: null,
            selectedLoginUserId: null,
            pendingVerifyUser: null,
            verifiedLoginUserId: null,
            signupDiscordNumericId: null,
            enteredPin: '',
            authMode: 'signup',
            currentPayCode: '849201',
            pendingTransfer: null,
            pendingPosPayment: null,

            merchants: [],
            currentMerchantId: null,
            selectedMerchantLoginId: null,
            merchantAuthMode: 'login',
            myMerchants: [],
            currentMerchantRole: null,
            merchantMembers: [],
            merchantTab: 'charge',

            selectedProduct: null,
            productPayMethod: 'cash'
        };

        function saveSession() {
            if (state.currentUserId) {
                localStorage.setItem(STORAGE_KEY_SESSION, state.currentUserId);
            } else {
                localStorage.removeItem(STORAGE_KEY_SESSION);
            }
            if (state.currentMerchantId) {
                localStorage.setItem(STORAGE_KEY_MERCHANT_SESSION, state.currentMerchantId);
            } else {
                localStorage.removeItem(STORAGE_KEY_MERCHANT_SESSION);
            }
        }

        async function saveAppData(extraMerchantIds) {
            saveSession();
            try {
                const user = getCurrentUser();

                if (user && state.sessionToken) {
                    const accountIds = (user.accounts || []).map(acc => acc.id);
                    let primaryId = null;
                    if (accountIds.length) {
                        primaryId = accountIds.includes(user.currentAccountId) ? user.currentAccountId : accountIds[0];
                        user.currentAccountId = primaryId;
                    }

                    const { error: profileErr } = await authRpc('app_update_profile', {
                        p_current_account_id: primaryId,
                        p_purchased_items: user.purchasedItems || []
                    });
                    if (profileErr && !isInvalidSessionError(profileErr)) console.error('프로필 저장 오류:', profileErr);
                }
            } catch (err) {
                console.error('Supabase 저장 오류:', err);
                showToast('서버 저장 중 오류가 발생했습니다. 네트워크를 확인해 주세요.');
            }
        }

        async function loadAppData() {
            const knownIds = getKnownAccountIds();

            const { data, error: firstErr } = await sbClient.rpc('app_public_bootstrap', { p_known_ids: knownIds });

            if (firstErr || !data) {
                console.error('Supabase 로드 오류:', firstErr);
                showToast('서버에서 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
                return;
            }

            state.hasUsers = !!data.has_users;

            state.users = (data.known_users || []).map(u => ({
                id: u.id,
                alias: u.alias,
                discord: u.discord,
                accounts: [],
                transactions: []
            }));

            const merchants = data.merchants;
            if (merchants && merchants.length) {
                state.merchants = merchants.map(m => ({
                    id: m.id,
                    name: m.name,
                    category: m.category,
                    bizNo: '',
                    accountNo: '',
                    unsettledBalance: 0,
                    totalSales: 0,
                    status: m.status || 'approved',
                    salesHistory: []
                }));
            } else if ((data.merchant_total || 0) === 0) {
                state.merchants = JSON.parse(JSON.stringify(defaultMerchants));
                saveAppData(state.merchants.map(m => m.id));
            } else {
                state.merchants = [];
            }
        }

        async function loadMerchantSales(mch) {
            try {
                const { data, error } = await merchantRpc('app_merchant_sales', { p_limit: 200 });

                if (error) {
                    console.error('매출 내역 조회 오류:', error);
                    mch.salesHistory = mch.salesHistory || [];
                    return;
                }

                mch.salesHistory = (data || []).map(x => ({
                    id: x.id,
                    title: x.title,
                    amount: x.amount,
                    feeAmount: x.fee_amount || 0,
                    date: x.date_label || '',
                    createdAt: x.created_at,
                    settled: x.settled
                }));
            } catch (err) {
                console.error('매출 내역 조회 오류:', err);
                mch.salesHistory = mch.salesHistory || [];
            }
        }

        async function loadUserFinancialData(userId) {
            const user = state.users.find(u => u.id === userId);
            if (!user) return;

            const { data: myData, error: aErr } = await authRpc('app_my_data');

            if (aErr || !myData) {
                console.error('계좌 조회 오류:', aErr);
                showToast('계좌 정보를 불러오지 못했습니다.');
                return;
            }

            const orderedRows = orderAccountRows(myData.accounts || [], getLocalAccountOrder(userId));
            user.accounts = orderedRows.map(a => ({ id: a.id, name: a.name, accountNo: a.account_no, balance: a.balance, isFrozen: a.is_frozen || false, accountType: a.account_type || 'checking', createdAt: a.created_at || '' }));
            user.interest = myData.interest || null;
            setLocalAccountOrder(userId, user.accounts.map(a => a.id));

            const transactions = myData.transactions || [];

            user.transactions = transactions.map(t => ({
                id: t.id,
                accountId: t.account_id,
                title: t.title,
                counterparty: t.counterparty_name || '',
                memo: t.memo || '',
                date: t.date_label || '',
                createdAt: t.created_at,
                amount: t.amount,
                type: t.type
            }));
        }

        const AD_BANNER_OPTIONS = {
            1: {
                link: 'https://namu.wiki/w/%EB%83%A5%EB%87%BD%EB%85%95%EB%83%A5',
                position: '50% 33%'
            }
        };
        const AD_MAX_COUNT = 30;
        const AD_SLIDE_INTERVAL_MS = 4000;

        function probeImage(src) {
            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
                img.src = src;
            });
        }

        async function discoverAdBanners() {
            const found = [];
            for (let n = 1; n <= AD_MAX_COUNT; n++) {
                let src = 'ad-' + n + '.png';
                if (!(await probeImage(src))) {
                    src = 'ad' + n + '.png';
                    if (!(await probeImage(src))) break;
                }
                const opt = AD_BANNER_OPTIONS[n] || {};
                found.push({ src: src, link: opt.link || '', position: opt.position || '' });
            }
            return found;
        }

        async function initAdPanels() {
            const banner = document.getElementById('home-ad-banner');
            if (!banner) return;

            const ads = await discoverAdBanners();

            if (!ads.length) {
                banner.classList.remove('hidden');
                banner.innerHTML = '<div class="ad-placeholder">AD</div>';
                return;
            }

            let current = Math.floor(Math.random() * ads.length);

            banner.classList.remove('hidden');
            banner.innerHTML = ads.map((img, idx) => {
                const posStyle = img.position ? ' style="object-position: ' + img.position + ';"' : '';
                const slideImg = '<img src="' + img.src + '" class="ad-slide' + (idx === current ? ' active' : '') + '" alt="광고"' + posStyle + '>';
                return img.link
                    ? '<a href="' + img.link + '" target="_blank" rel="noopener noreferrer" class="block w-full h-full">' + slideImg + '</a>'
                    : slideImg;
            }).join('');

            if (ads.length > 1) {
                setInterval(() => {
                    const slides = banner.querySelectorAll('.ad-slide');
                    if (slides.length < 2) return;
                    let next = current;
                    while (next === current) next = Math.floor(Math.random() * slides.length);
                    slides[current].classList.remove('active');
                    current = next;
                    slides[current].classList.add('active');
                }, AD_SLIDE_INTERVAL_MS);
            }
        }

        window.addEventListener('DOMContentLoaded', async () => {
            try { startVersionCheckPolling(); } catch (err) { console.error('버전 확인 시작 오류:', err); }
            initAdPanels().catch(err => console.error('광고 초기화 오류:', err));

            setInterval(() => {
                if (getCurrentUser() && !isClaimingAttendance) renderAttendanceWidget();
            }, 60000);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && getCurrentUser() && !isClaimingAttendance) renderAttendanceWidget();
            });

            const dismissLoadingToast = showLoadingToast('서버에서 데이터를 불러오는 중입니다...');

            let loaded = false;
            try {
                await Promise.race([
                    loadAppData().then(() => { loaded = true; }),
                    new Promise((resolve, reject) => setTimeout(() => reject(new Error('load_timeout')), 10000))
                ]);
            } catch (err) {
                console.error('초기 데이터 로드 오류:', err);
                showToast('서버 연결이 지연되고 있습니다. 잠시 후 새로고침해 주세요.');
            }

            dismissLoadingToast();
            if (loaded) showToast('서버 데이터를 모두 불러왔습니다.');

            state.currentUserId = null;

            if (!loaded) state.hasUsers = true;

            try {
                if (state.hasUsers) {
                    state.authMode = 'login';
                } else {
                    state.authMode = 'signup';
                }
                renderAuthLoginView();
            } catch (err) {
                console.error('로그인 화면 표시 오류:', err);
            }

            try {
                await handleDiscordVerificationReturn();
                await handleDiscordSignupReturn();
            } catch (err) {
                console.error('디스코드 인증 복귀 처리 오류:', err);
            }

            try {
                if (state.currentMerchantId === null) {
                    const savedMchId = localStorage.getItem(STORAGE_KEY_MERCHANT_SESSION);
                    if (savedMchId && state.merchants.some(m => m.id === savedMchId)) {
                        state.selectedMerchantLoginId = savedMchId;
                    } else if (state.merchants.length) {
                        state.selectedMerchantLoginId = state.merchants[0].id;
                    }
                }
            } catch (err) {
                console.error('가맹점 초기화 오류:', err);
            }
        });

        function getCurrentUser() {
            return state.users.find(u => u.id === state.currentUserId) || null;
        }

        function getCurrentMerchant() {
            return state.merchants.find(m => m.id === state.currentMerchantId) || null;
        }

        function getActiveAccount() {
            const user = getCurrentUser();
            if (!user) return null;
            return user.accounts.find(acc => acc.id === user.sessionAccountId)
                || user.accounts.find(acc => acc.id === user.currentAccountId)
                || user.accounts[0];
        }

        function getPrimaryAccount() {
            const user = getCurrentUser();
            if (!user) return null;
            return user.accounts.find(acc => acc.id === user.currentAccountId) || user.accounts[0] || null;
        }

        function isInvalidSessionError(err) {
            return !!err && String(err.message || '').includes('invalid_session');
        }

        function handleSessionExpired() {
            if (!getCurrentUser()) return;
            showToast('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
            logout();
        }

        function handleMerchantSessionExpired() {
            if (!getCurrentMerchant()) return;
            showToast('가맹점 세션이 만료되었습니다. 다시 로그인해 주세요.');
            logoutMerchant();
        }

        async function authRpc(name, args) {
            const res = await sbClient.rpc(name, Object.assign({ p_token: state.sessionToken }, args || {}));
            if (res && res.error && isInvalidSessionError(res.error)) handleSessionExpired();
            return res;
        }

        async function merchantRpc(name, args) {
            const res = await sbClient.rpc(name, Object.assign({ p_token: state.merchantToken }, args || {}));
            if (res && res.error && isInvalidSessionError(res.error)) handleMerchantSessionExpired();
            return res;
        }

        async function refreshMerchantFromServer(merchantId) {
            try {
                const { data } = await merchantRpc('app_merchant_state');
                const mch = state.merchants.find(m => m.id === merchantId);
                if (!data || !mch) return;
                mch.unsettledBalance = data.unsettled_balance || 0;
                mch.totalSales = data.total_sales || 0;
                await loadMerchantSales(mch);
                const current = getCurrentMerchant();
                if (current && current.id === merchantId) renderMerchantDashboard();
            } catch (err) {
                console.error('가맹점 정보 갱신 오류:', err);
            }
        }

        function genRequestId() {
            try {
                if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
            } catch (e) {}
            return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
        }

        function parseAmountInput(value) {
            const t = String(value == null ? '' : value).trim();
            if (!/^\d{1,15}$/.test(t)) return 0;
            const n = Number(t);
            return Number.isSafeInteger(n) ? n : 0;
        }

        function genId(prefix) {
            return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        }

        let versionCheckTimer = null;

        function currentLoadedBuildVersion() {
            const el = document.querySelector('script[src*="app.js"]');
            const m = el ? (el.getAttribute('src') || '').match(/[?&]v=([^&]+)/) : null;
            return m ? m[1] : null;
        }

        function extractBuildVersion(html) {
            const m = html.match(/app\.js\?v=([^"'&\s]+)/);
            return m ? m[1] : null;
        }

        async function checkForNewVersion() {
            try {
                const res = await fetch(location.pathname + '?_=' + Date.now(), { cache: 'no-store' });
                if (!res.ok) return;
                const html = await res.text();
                const liveVersion = extractBuildVersion(html);
                const loadedVersion = currentLoadedBuildVersion();
                if (liveVersion && loadedVersion && liveVersion !== loadedVersion) {
                    const banner = document.getElementById('app-update-banner');
                    if (banner) banner.classList.remove('hidden');
                    if (versionCheckTimer) {
                        clearInterval(versionCheckTimer);
                        versionCheckTimer = null;
                    }
                }
            } catch (err) {
                console.error('버전 확인 오류:', err);
            }
        }

        function startVersionCheckPolling() {
            checkForNewVersion();
            versionCheckTimer = setInterval(checkForNewVersion, 30000);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkForNewVersion();
            });
        }

        async function refreshNotifBadge() {
            const user = getCurrentUser();
            const badge = document.getElementById('notif-badge');
            if (!user || !badge) return;

            try {
                const { data: count, error } = await authRpc('app_unread_notif_count');

                if (error) {
                    console.error('알림 개수 조회 오류:', error);
                    return;
                }

                if (count && count > 0) {
                    badge.innerText = count > 99 ? '99+' : String(count);
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            } catch (err) {
                console.error('알림 개수 조회 오류:', err);
            }
        }

        function renderNotificationList(items) {
            const listEl = document.getElementById('notif-list');
            const clearBtn = document.getElementById('notif-clear-all-btn');
            if (!listEl) return;

            if (!items || items.length === 0) {
                listEl.innerHTML = '<div class="text-center py-10 text-xs text-zinc-400">받은 알림이 없습니다.</div>';
                if (clearBtn) clearBtn.classList.add('hidden');
                return;
            }

            if (clearBtn) clearBtn.classList.remove('hidden');
            listEl.innerHTML = items.map(n => {
                const unreadDot = n.read ? '' : '<span class="w-2 h-2 bg-red-500 rounded-full inline-block mr-1.5"></span>';
                return '<div data-notif-id="' + escapeHtml(n.id) + '" class="bg-white p-3.5 rounded-2xl border border-zinc-200/80 shadow-sm flex items-start gap-2">' +
                    '<div class="flex-1 min-w-0">' +
                        '<div class="flex items-center text-xs font-bold text-zinc-900">' + unreadDot + escapeHtml(n.title) + '</div>' +
                        (n.body ? '<div class="text-[11px] text-zinc-500 mt-1">' + escapeHtml(n.body) + '</div>' : '') +
                        '<div class="text-[10px] text-zinc-400 mt-1.5">' + formatRelativeDate(n.created_at) + '</div>' +
                    '</div>' +
                    '<button onclick="deleteNotification(' + jsArg(n.id) + ')" aria-label="알림 삭제" class="w-7 h-7 shrink-0 flex items-center justify-center text-zinc-300 hover:text-red-500 rounded-lg hover:bg-zinc-50 transition-colors">' +
                        '<i class="fa-regular fa-trash-can text-xs"></i>' +
                    '</button>' +
                '</div>';
            }).join('');
        }

        async function openNotificationModal() {
            const user = getCurrentUser();
            const listEl = document.getElementById('notif-list');
            const clearBtn = document.getElementById('notif-clear-all-btn');
            if (!user || !listEl) return;

            if (clearBtn) clearBtn.classList.add('hidden');
            listEl.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">불러오는 중...</div>';
            openModal('modal-notifications');

            try {
                const { data, error } = await authRpc('app_list_notifications', { p_limit: 50 });

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">알림을 불러오지 못했습니다.</div>';
                    return;
                }

                renderNotificationList(data);

                await authRpc('app_mark_notifications_read');
                refreshNotifBadge();
            } catch (err) {
                console.error('알림함 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">알림을 불러오지 못했습니다.</div>';
            }
        }

        async function deleteNotification(id) {
            if (!getCurrentUser()) return;

            try {
                const { data, error } = await authRpc('app_delete_notification', { p_id: id });
                if (error || !data || !data.ok) {
                    showToast('알림을 삭제하지 못했습니다.');
                    return;
                }
            } catch (err) {
                console.error('알림 삭제 오류:', err);
                showToast('알림을 삭제하지 못했습니다.');
                return;
            }

            const listEl = document.getElementById('notif-list');
            if (listEl) {
                const item = Array.from(listEl.children).find(el => el.dataset && el.dataset.notifId === id);
                if (item) item.remove();
                if (!listEl.querySelector('[data-notif-id]')) renderNotificationList([]);
            }
            refreshNotifBadge();
        }

        async function deleteAllNotifications() {
            if (!getCurrentUser()) return;
            if (!window.confirm('알림을 모두 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;

            try {
                const { data, error } = await authRpc('app_delete_all_notifications');
                if (error || !data || !data.ok) {
                    showToast('알림을 삭제하지 못했습니다.');
                    return;
                }
            } catch (err) {
                console.error('알림 전체 삭제 오류:', err);
                showToast('알림을 삭제하지 못했습니다.');
                return;
            }

            renderNotificationList([]);
            refreshNotifBadge();
            showToast('알림을 모두 삭제했습니다.');
        }

        const USER_POLL_INTERVAL_MS = 3000;
        let userPollTimer = null;
        let userPollBusy = false;

        function subscribeToRealtimeUpdates() {
            unsubscribeRealtimeUpdates();
            const user = getCurrentUser();
            if (!user || !state.sessionToken) return;
            userPollTimer = setInterval(pollUserUpdates, USER_POLL_INTERVAL_MS);
            pollUserUpdates();
        }

        function unsubscribeRealtimeUpdates() {
            if (userPollTimer) {
                clearInterval(userPollTimer);
                userPollTimer = null;
            }
            userPollBusy = false;
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && userPollTimer) pollUserUpdates();
        });

        async function pollUserUpdates() {
            if (userPollBusy || document.visibilityState === 'hidden') return;
            const startUser = getCurrentUser();
            if (!startUser || !state.sessionToken) return;

            userPollBusy = true;
            try {
                const { data, error } = await authRpc('app_my_poll');
                if (error || !data) return;

                const user = getCurrentUser();
                if (!user || user.id !== startUser.id) return;

                let changed = false;
                (data.accounts || []).forEach(row => {
                    const acc = (user.accounts || []).find(a => a.id === row.id);
                    if (!acc) return;
                    const frozen = !!row.is_frozen;
                    if (acc.balance !== row.balance || !!acc.isFrozen !== frozen) {
                        acc.balance = row.balance;
                        acc.isFrozen = frozen;
                        changed = true;
                    }
                });
                if (changed) renderApp();

                (data.recent_transactions || []).slice().reverse().forEach(row => {
                    handleTransactionRealtimeChange({ new: row });
                });

                handlePendingPaymentFromPoll(data.pending_payment);

                const badge = document.getElementById('notif-badge');
                const unread = data.unread_count || 0;
                if (badge) {
                    if (unread > 0) {
                        badge.innerText = unread > 99 ? '99+' : String(unread);
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            } catch (err) {
                console.error('실시간 갱신 오류:', err);
            } finally {
                userPollBusy = false;
            }
        }

        function handleTransactionRealtimeChange(payload) {
            const row = payload.new;
            const user = getCurrentUser();
            if (!row || !user) return;

            const isMine = (user.accounts || []).some(a => a.id === row.account_id);
            if (!isMine) return;

            const already = (user.transactions || []).some(t => t.id === row.id);
            if (already) return;

            user.transactions.unshift({
                id: row.id,
                accountId: row.account_id,
                title: row.title,
                counterparty: row.counterparty_name || '',
                memo: row.memo || '',
                date: row.date_label || '방금 전',
                createdAt: row.created_at,
                amount: row.amount,
                type: row.type
            });
            renderApp();

            if (row.amount > 0) {
                showToast(formatNumber(row.amount) + '원이 입금되었습니다.' + (row.memo ? ' "' + row.memo + '"' : ''));
            }
        }

        let activePaymentRequest = null;

        function handlePendingPaymentFromPoll(row) {
            const user = getCurrentUser();
            if (!user) return;

            if (!row) {
                if (activePaymentRequest) hidePaymentRequestBanner();
                return;
            }
            if (row.user_id !== user.id || row.status !== 'pending') return;
            if (activePaymentRequest && activePaymentRequest.id === row.id) return;

            activePaymentRequest = row;
            showPaymentRequestBanner(row);
        }

        function showPaymentRequestBanner(row) {
            const banner = document.getElementById('payment-request-banner');
            if (!banner) return;

            document.getElementById('payment-request-merchant-name').innerText = row.merchant_name;
            document.getElementById('payment-request-amount').innerText = formatNumber(row.amount) + '원';
            banner.classList.remove('hidden');
        }

        function hidePaymentRequestBanner() {
            const banner = document.getElementById('payment-request-banner');
            if (banner) banner.classList.add('hidden');
            activePaymentRequest = null;
        }

        async function approvePaymentRequest() {
            if (!activePaymentRequest) return;
            const req = activePaymentRequest;

            const user = getCurrentUser();
            const activeAcc = user ? (user.accounts || []).find(a => a.id === req.account_id) : null;
            if (!user || !activeAcc) {
                hidePaymentRequestBanner();
                return;
            }

            if (activeAcc.isFrozen) {
                hidePaymentRequestBanner();
                showToast('정지된 계좌라 결제를 승인할 수 없습니다.');
                return;
            }

            hidePaymentRequestBanner();
            showToast('결제를 승인하는 중입니다...');

            try {

                const { data, error } = await authRpc('app_approve_payment', { p_request_id: req.id });
                if (error) {
                    console.error('결제 승인 오류:', error);
                    showToast('결제 처리 중 오류가 발생했습니다.');
                    return;
                }

                const result = Array.isArray(data) ? data[0] : data;
                if (!result || !result.ok) {
                    const reasonMsg = {
                        insufficient_balance: '계좌 잔액이 부족하여 결제가 취소되었습니다.',
                        frozen: '정지된 계좌라 결제할 수 없습니다.',
                        expired: '이미 만료된 결제 요청입니다.',
                        already_processed: '이미 처리된 결제 요청입니다.',
                        not_found: '결제 요청을 찾을 수 없습니다.',
                        merchant_unavailable: '결제를 처리할 수 없는 가맹점입니다.'
                    }[result && result.reason] || '결제를 처리할 수 없습니다.';
                    showToast(reasonMsg);
                    return;
                }

                activeAcc.balance = result.new_balance;
                if (!user.transactions.some(t => t.id === result.tx_id)) {
                    user.transactions.unshift({
                        id: result.tx_id || genId('tx'),
                        accountId: activeAcc.id,
                        title: req.merchant_name + ' 결제',
                        counterparty: req.merchant_name,
                        date: '방금 전',
                        createdAt: new Date().toISOString(),
                        amount: -req.amount,
                        type: 'pay'
                    });
                }
                renderApp();
                showToast(formatNumber(req.amount) + '원 결제를 승인했습니다.');
            } catch (err) {
                console.error('결제 승인 처리 오류:', err);
                showToast('결제 승인 처리 중 오류가 발생했습니다.');
            }
        }

        async function rejectPaymentRequest() {
            if (!activePaymentRequest) return;
            const reqId = activePaymentRequest.id;
            hidePaymentRequestBanner();

            try {
                await authRpc('app_reject_payment', { p_request_id: reqId });
                showToast('결제 요청을 거절했습니다.');
            } catch (err) {
                console.error('결제 거절 처리 오류:', err);
            }
        }

        function rollNumber(el, oldValue, newValue, duration) {
            if (!el) return;
            duration = duration || 900;

            const newStr = formatNumber(newValue);
            el.setAttribute('aria-label', newStr + '원');
            el._rollToken = (el._rollToken || 0) + 1;
            const token = el._rollToken;
            el.classList.add('roll-number');

            if (oldValue === newValue) {
                el.textContent = newStr;
                return;
            }

            const dir = newValue > oldValue ? 1 : -1;
            const oldStr = formatNumber(oldValue);
            const oldDigits = oldStr.replace(/\D/g, '');
            const newDigits = newStr.replace(/\D/g, '');
            const shorter = Math.min(oldDigits.length, newDigits.length);
            const lengthChanged = oldDigits.length !== newDigits.length;
            const layoutStr = oldDigits.length >= newDigits.length ? oldStr : newStr;
            const layoutDigits = layoutStr.replace(/\D/g, '').length;
            const RUNS = 3;
            const TOTAL = 1 + 10 * RUNS;
            const idx = (d, run) => 1 + run * 10 + d;
            const pct = pos => -(pos / TOTAL) * 100;
            const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';

            el.textContent = '';

            const moves = [];
            const widthMoves = [];
            let seen = 0;

            layoutStr.split('').forEach(ch => {
                if (!/\d/.test(ch)) {
                    const sep = document.createElement('span');
                    sep.className = 'roll-static';
                    sep.textContent = ch;
                    el.appendChild(sep);
                    if (ch === ',' && lengthChanged && (layoutDigits - seen) >= shorter) {
                        widthMoves.push({ node: sep, grow: newDigits.length > oldDigits.length });
                    }
                    return;
                }

                const fromRight = layoutDigits - 1 - seen;
                seen++;

                const oldD = fromRight < oldDigits.length ? parseInt(oldDigits[oldDigits.length - 1 - fromRight], 10) : null;
                const target = fromRight < newDigits.length ? parseInt(newDigits[newDigits.length - 1 - fromRight], 10) : null;

                let startPos;
                let endPos;
                if (oldD !== null && target !== null) {
                    startPos = idx(oldD, 1);
                    const steps = dir > 0 ? ((target - oldD + 10) % 10) : -((oldD - target + 10) % 10);
                    endPos = startPos + steps;
                } else if (oldD !== null) {
                    startPos = idx(oldD, 0);
                    endPos = 0;
                } else {
                    startPos = 0;
                    endPos = idx(target, 0);
                }

                const col = document.createElement('span');
                col.className = 'roll-digit';
                const strip = document.createElement('span');
                strip.className = 'roll-strip';
                for (let n = 0; n < TOTAL; n++) {
                    const item = document.createElement('span');
                    item.className = 'roll-item';
                    item.textContent = n === 0 ? '' : String((n - 1) % 10);
                    strip.appendChild(item);
                }
                strip.style.transform = 'translateY(' + pct(startPos) + '%)';
                col.appendChild(strip);
                el.appendChild(col);

                if (endPos !== startPos) moves.push({ strip, endPos });
                if (oldD === null || target === null) {
                    widthMoves.push({ node: col, grow: oldD === null });
                }
            });

            widthMoves.forEach(w => {
                w.width = w.node.getBoundingClientRect().width;
                w.node.style.overflow = 'hidden';
                w.node.style.width = (w.grow ? 0 : w.width) + 'px';
            });

            void el.offsetWidth;

            moves.forEach((m, order) => {
                m.strip.style.transition = 'transform ' + duration + 'ms ' + easing + ' ' + (order * 45) + 'ms';
                m.strip.style.transform = 'translateY(' + pct(m.endPos) + '%)';
            });

            widthMoves.forEach(w => {
                w.node.style.transition = 'width ' + duration + 'ms ' + easing;
                w.node.style.width = (w.grow ? w.width : 0) + 'px';
            });

            setTimeout(() => {
                if (el._rollToken !== token) return;
                el.textContent = newStr;
            }, duration + moves.length * 45 + 80);
        }

        function animateNumberChange(element, newValue, duration) {
            if (!element) return;
            const prev = element.dataset.rollValue !== undefined ? Number(element.dataset.rollValue) : newValue;
            element.dataset.rollValue = String(newValue);
            rollNumber(element, prev, newValue, duration);
        }

        function copyTextToClipboard(text, successMsg) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text)
                    .then(() => showToast(successMsg))
                    .catch(() => fallbackCopyText(text, successMsg));
            } else {
                fallbackCopyText(text, successMsg);
            }
        }

        function copyPaymentCode() {
            if (!state.currentPayCode) return;
            const text = state.currentPayCode;
            copyTextToClipboard(text, '결제 코드가 복사되었습니다: ' + text);
        }

        function copyAccountNo(accId) {
            const user = getCurrentUser();
            if (!user) return;
            const acc = accId ? user.accounts.find(a => a.id === accId) : getActiveAccount();
            if (!acc) return;
            copyTextToClipboard(acc.accountNo, '계좌번호가 복사되었습니다: ' + acc.accountNo);
        }

        function fallbackCopyText(text, successMsg) {
            const temp = document.createElement('textarea');
            temp.value = text;
            temp.style.position = 'fixed';
            temp.style.opacity = '0';
            document.body.appendChild(temp);
            temp.focus();
            temp.select();
            try {
                const ok = document.execCommand('copy');
                showToast(ok ? (successMsg || '복사되었습니다: ' + text) : '복사에 실패했습니다. 직접 드래그해서 선택해 주세요.');
            } catch (err) {
                showToast('복사에 실패했습니다. 직접 드래그해서 선택해 주세요.');
            }
            document.body.removeChild(temp);
        }

        function toggleCategoryDropdown() {
            const dropdown = document.getElementById('mch-category-dropdown');
            if (dropdown) dropdown.classList.toggle('hidden');
        }

        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('mch-category-dropdown');
            const btn = document.getElementById('mch-category-btn');
            if (!dropdown || dropdown.classList.contains('hidden')) return;
            if (dropdown.contains(e.target) || (btn && btn.contains(e.target))) return;
            dropdown.classList.add('hidden');
        });

        function selectCategory(value, iconClass) {
            const hiddenInput = document.getElementById('mch-signup-category');
            const label = document.getElementById('mch-category-label');
            const btnIcon = document.querySelector('#mch-category-btn i.fa-solid:not(.fa-chevron-down)');
            const dropdown = document.getElementById('mch-category-dropdown');

            if (hiddenInput) hiddenInput.value = value;
            if (label) label.innerText = value;
            if (btnIcon) {
                btnIcon.className = 'fa-solid ' + iconClass + ' text-zinc-500 w-3.5';
            }
            if (dropdown) dropdown.classList.add('hidden');
        }

        function togglePinVisibility(inputId, btn) {
            const input = document.getElementById(inputId);
            if (!input) return;
            const icon = btn.querySelector('i');
            if (input.type === 'password') {
                input.type = 'text';
                if (icon) { icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); }
            } else {
                input.type = 'password';
                if (icon) { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
            }
        }

        function debounce(fn, delay) {
            let timer = null;
            return function (...args) {
                clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), delay ?? 300);
            };
        }

        const debouncedRenderAdminUserList = debounce((value) => renderAdminUserList(value), 300);
        const debouncedRenderAdminMerchantList = debounce((value) => renderAdminMerchantList(value), 300);
        const debouncedRenderAdminTransactionSearch = debounce((value) => renderAdminTransactionSearch(value), 300);

        function escapeHtml(str) {
            return String(str === null || str === undefined ? '' : str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function isValidAlias(alias) {
            const v = String(alias || '').trim();
            if (v.length < 1 || v.length > 20) return false;
            return !/[<>"'`\\\u0000-\u001f\u007f\u2028\u2029]/.test(v);
        }

        function jsArg(value) {
            return escapeHtml(JSON.stringify(String(value === null || value === undefined ? '' : value)));
        }

        function formatRelativeDate(isoString) {
            if (!isoString) return '';
            const then = new Date(isoString);
            if (isNaN(then.getTime())) return '';
            const now = new Date();
            const diffMs = now - then;
            const diffMin = Math.floor(diffMs / 60000);

            if (diffMin < 1) return '방금 전';
            if (diffMin < 60) return diffMin + '분 전';

            const pad = n => n.toString().padStart(2, '0');
            const hh = pad(then.getHours());
            const mm = pad(then.getMinutes());

            const isSameDay = then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate();
            if (isSameDay) return '오늘 ' + hh + ':' + mm;

            const yesterday = new Date(now);
            yesterday.setDate(now.getDate() - 1);
            const isYesterday = then.getFullYear() === yesterday.getFullYear() && then.getMonth() === yesterday.getMonth() && then.getDate() === yesterday.getDate();
            if (isYesterday) return '어제 ' + hh + ':' + mm;

            if (then.getFullYear() === now.getFullYear()) {
                return (then.getMonth() + 1) + '월 ' + then.getDate() + '일';
            }
            return then.getFullYear() + '.' + pad(then.getMonth() + 1) + '.' + pad(then.getDate());
        }

        function formatNumber(num) {
            return (num || 0).toLocaleString('ko-KR');
        }

        const TOAST_MAX_COUNT = 5;

        function hideToastElement(toast) {
            if (!toast || !toast.isConnected) return;
            toast.classList.add('opacity-0', 'translate-y-[-10px]');
            setTimeout(() => toast.remove(), 300);
        }

        function showToast(message) {
            if (typeof isOverlayOpen === 'function' && isOverlayOpen()) showOverlayToast(message);
            createToast(message, true, false);
        }

        function showLoadingToast(message) {
            const toast = createToast(message, false, true);
            return () => hideToastElement(toast);
        }

        function createToast(message, autoHide, withSpinner) {
            const container = document.getElementById('toast-container');
            if (!container) return null;

            while (container.children.length >= TOAST_MAX_COUNT) {
                container.removeChild(container.firstElementChild);
            }

            const toast = document.createElement('div');
            toast.className = 'pointer-events-auto bg-zinc-900/95 text-white px-4 py-3 rounded-2xl text-xs font-medium shadow-floating flex items-center justify-between transition-all duration-300 opacity-0 translate-y-[-10px] backdrop-blur-md border border-zinc-700/50';

            const msgSpan = document.createElement('span');
            if (withSpinner) {
                const spinner = document.createElement('i');
                spinner.className = 'fa-solid fa-spinner fa-spin text-zinc-300 text-xs mr-2';
                msgSpan.appendChild(spinner);
            }
            msgSpan.appendChild(document.createTextNode(message));

            const closeIcon = document.createElement('i');
            closeIcon.className = 'fa-solid fa-xmark text-zinc-400 text-xs ml-2 cursor-pointer';
            closeIcon.onclick = () => toast.remove();

            toast.appendChild(msgSpan);
            toast.appendChild(closeIcon);

            container.appendChild(toast);

            requestAnimationFrame(() => {
                toast.classList.remove('opacity-0', 'translate-y-[-10px]');
            });

            if (autoHide) {
                setTimeout(() => hideToastElement(toast), 3000);
            }

            return toast;
        }

        function getDepositAccount() {
            const user = getCurrentUser();
            if (!user) return null;
            const target = state.depositTargetId
                ? (user.accounts || []).find(a => a.id === state.depositTargetId)
                : null;
            return target || getPrimaryAccount();
        }

        function depositAccountLabel(acc) {
            const primary = getPrimaryAccount();
            return (primary && primary.id === acc.id ? '주계좌 · ' : '') + acc.name;
        }

        function openDepositModal(accId) {
            state.depositTargetId = typeof accId === 'string' ? accId : null;
            const amtInput = document.getElementById('deposit-amount');
            const memoInput = document.getElementById('deposit-memo');
            if (amtInput) amtInput.value = '';
            if (memoInput) memoInput.value = '';

            const targetEl = document.getElementById('deposit-target-account');
            const target = getDepositAccount();
            if (targetEl) {
                if (target) {
                    targetEl.innerText = '충전 계좌: ' + depositAccountLabel(target) + ' (' + target.accountNo + ')';
                    targetEl.classList.remove('hidden');
                } else {
                    targetEl.classList.add('hidden');
                }
            }

            openModal('modal-deposit');
        }

        async function submitTopupRequest() {
            const amtInput = document.getElementById('deposit-amount');
            const memoInput = document.getElementById('deposit-memo');
            const amt = amtInput ? parseAmountInput(amtInput.value) : 0;
            const memo = memoInput ? memoInput.value.trim() : '';

            if (!amt || amt <= 0) {
                showToast('충전할 금액을 올바르게 입력해 주세요.');
                return;
            }

            const user = getCurrentUser();
            const activeAcc = getDepositAccount();
            if (!user || !activeAcc) return;

            const submitBtn = document.getElementById('deposit-submit-btn');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerText = '요청 전송 중...';
            }

            try {
                const { data: topupData, error: topupErr } = await authRpc('app_request_topup', {
                    p_account_id: activeAcc.id,
                    p_amount: amt,
                    p_memo: memo || null
                });
                if (topupErr || !topupData || !topupData.ok) {
                    const reason = topupData && topupData.reason;
                    showToast(reason === 'too_many_pending'
                        ? '처리 대기 중인 충전 요청이 너무 많습니다. 승인 후 다시 요청해 주세요.'
                        : reason === 'invalid_amount'
                            ? '충전 금액은 1천만 원 이하로 입력해 주세요.'
                            : '충전 요청 전송 중 오류가 발생했습니다.');
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = '충전 요청 보내기'; }
                    return;
                }
            } catch (err) {
                console.error('충전 요청 생성 오류:', err);
                showToast('충전 요청 전송 중 오류가 발생했습니다.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = '충전 요청 보내기'; }
                return;
            }

            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = '충전 요청 보내기';
            }

            closeModal('modal-deposit');
            showToast('충전 요청을 보냈습니다. 관리자 승인 후 ' + depositAccountLabel(activeAcc) + ' 계좌에 반영됩니다.');
        }

        function toggleAuthMode() {
            state.authMode = state.authMode === 'login' ? 'signup' : 'login';
            state.enteredPin = '';
            renderAuthLoginView();
        }

        function renderAuthLoginView() {
            const loginView = document.getElementById('auth-login-view');
            const signupView = document.getElementById('auth-signup-view');
            const toggleBtn = document.getElementById('auth-toggle-btn');
            const selector = document.getElementById('auth-user-selector');
            const lookupSection = document.getElementById('auth-account-lookup');
            const verifySection = document.getElementById('auth-verify-pending');
            const pinSection = document.getElementById('auth-pin-section');

            if (state.authMode === 'signup' || !state.hasUsers) {
                loginView.classList.add('hidden');
                signupView.classList.remove('hidden');
                toggleBtn.innerText = state.hasUsers ? '기존 계정 로그인' : '신규 회원가입';
                return;
            }

            loginView.classList.remove('hidden');
            signupView.classList.add('hidden');
            toggleBtn.innerText = '신규 회원가입';

            if (state.pendingVerifyUser) {
                lookupSection.classList.add('hidden');
                pinSection.classList.add('hidden');
                verifySection.classList.remove('hidden');
                document.getElementById('auth-verify-avatar').innerText = state.pendingVerifyUser.alias.charAt(0);
                document.getElementById('auth-verify-alias').innerText = state.pendingVerifyUser.alias;
                document.getElementById('auth-verify-discord').innerText = state.pendingVerifyUser.discord;
                return;
            }
            verifySection.classList.add('hidden');

            if (!state.verifiedLoginUserId) {
                const rememberedId = getRememberedLoginUserId();
                if (rememberedId) {
                    if (state.users.some(u => u.id === rememberedId)) {
                        state.verifiedLoginUserId = rememberedId;
                    } else {
                        forgetRememberedLoginUser();
                    }
                }
            }

            const activeUser = state.verifiedLoginUserId
                ? state.users.find(u => u.id === state.verifiedLoginUserId)
                : null;

            if (!activeUser) {
                state.verifiedLoginUserId = null;
                state.selectedLoginUserId = null;
                selector.innerHTML = '';
                lookupSection.classList.remove('hidden');
                pinSection.classList.add('hidden');
                return;
            }

            state.selectedLoginUserId = activeUser.id;
            lookupSection.classList.add('hidden');
            pinSection.classList.remove('hidden');

            document.getElementById('auth-user-avatar').innerText = activeUser.alias.charAt(0);
            document.getElementById('auth-user-alias').innerText = activeUser.alias;
            document.getElementById('auth-user-discord').innerText = activeUser.discord;
            selector.innerHTML = '';

            updatePinDots();
        }

        function showAccountLookup() {
            forgetRememberedLoginUser();
            sbClient.auth.signOut().then(() => {}, () => {});
            state.pendingVerifyUser = null;
            state.verifiedLoginUserId = null;
            state.selectedLoginUserId = null;
            state.enteredPin = '';
            renderAuthLoginView();
            const input = document.getElementById('auth-lookup-input');
            if (input) { input.value = ''; input.focus(); }
        }

        function cancelAccountVerify() {
            state.pendingVerifyUser = null;
            state.verifiedLoginUserId = null;
            state.selectedLoginUserId = null;
            renderAuthLoginView();
        }

        async function lookupAccount() {
            const input = document.getElementById('auth-lookup-input');
            const query = input ? input.value.trim() : '';

            if (!query) {
                showToast('가명 또는 디스코드 ID을 입력해 주세요.');
                return;
            }

            let matches = [];
            try {
                const { data, error } = await sbClient.rpc('app_find_login_account', { p_query: query });
                if (error) {
                    console.error('계정 조회 오류:', error);
                    showToast('계정 조회 중 오류가 발생했습니다.');
                    return;
                }
                matches = data || [];
            } catch (err) {
                console.error('계정 조회 오류:', err);
                showToast('계정 조회 중 오류가 발생했습니다.');
                return;
            }

            if (matches.length === 0) {
                showToast('일치하는 계정을 찾을 수 없습니다. 정확히 입력했는지 확인해 주세요.');
                return;
            }
            if (matches.length > 1) {
                showToast('동일한 정보의 계정이 여러 개 있습니다. 디스코드 ID까지 정확히 입력해 주세요.');
                return;
            }

            const found = matches[0];
            if (!state.users.some(u => u.id === found.id)) {
                state.users.push({ id: found.id, alias: found.alias, discord: found.discord, accounts: [], transactions: [] });
            }

            state.pendingVerifyUser = { id: found.id, alias: found.alias, discord: found.discord };
            renderAuthLoginView();
        }

        const DISCORD_VERIFY_FLAG_KEY = 'kdb_pay_discord_verify_pending';
        const DISCORD_VERIFY_TARGET_USER_KEY = 'kdb_pay_discord_verify_target_user';

        async function startDiscordVerification() {
            if (!state.pendingVerifyUser) {
                showToast('먼저 계정을 찾아 주세요.');
                return;
            }
            try {
                localStorage.setItem(DISCORD_VERIFY_FLAG_KEY, '1');
                localStorage.setItem(DISCORD_VERIFY_TARGET_USER_KEY, state.pendingVerifyUser.id);
                const returnUrl = window.location.href.split('#')[0].split('?')[0];
                const { error } = await sbClient.auth.signInWithOAuth({
                    provider: 'discord',
                    options: { redirectTo: returnUrl }
                });
                if (error) {
                    console.error('디스코드 인증 시작 오류:', error);
                    showToast('디스코드 인증을 시작하지 못했습니다: ' + (error.message || ''));
                    localStorage.removeItem(DISCORD_VERIFY_FLAG_KEY);
                    localStorage.removeItem(DISCORD_VERIFY_TARGET_USER_KEY);
                }
            } catch (err) {
                console.error('디스코드 인증 시작 오류:', err);
                showToast('디스코드 인증을 시작하지 못했습니다.');
                localStorage.removeItem(DISCORD_VERIFY_FLAG_KEY);
                localStorage.removeItem(DISCORD_VERIFY_TARGET_USER_KEY);
            }
        }

        async function handleDiscordVerificationReturn() {
            const pending = localStorage.getItem(DISCORD_VERIFY_FLAG_KEY);
            const targetUserId = localStorage.getItem(DISCORD_VERIFY_TARGET_USER_KEY);
            if (!pending) return;
            localStorage.removeItem(DISCORD_VERIFY_FLAG_KEY);
            localStorage.removeItem(DISCORD_VERIFY_TARGET_USER_KEY);

            if (!targetUserId) {
                showToast('본인 확인 대상 계정 정보가 없습니다. 계정을 다시 찾아 주세요.');
                return;
            }

            try {
                const { data: sessionData, error: sessionError } = await sbClient.auth.getSession();
                const session = sessionData && sessionData.session;

                if (sessionError || !session || !session.user) {
                    showToast('디스코드 인증에 실패했습니다. 다시 시도해 주세요.');
                    return;
                }

                const { data: verifyResult, error: verifyErr } = await sbClient.rpc('app_verify_discord_login', {
                    p_user_id: targetUserId
                });

                if (verifyErr || !verifyResult) {
                    console.error('본인확인 오류:', verifyErr);
                    showToast('본인 확인 중 오류가 발생했습니다.');
                    return;
                }

                if (!verifyResult.ok) {
                    if (verifyResult.reason === 'no_discord_session') {
                        showToast('디스코드 계정 정보를 확인하지 못했습니다.');
                    } else if (verifyResult.reason === 'no_discord_id') {
                        showToast('이 계정에는 디스코드 숫자 ID가 등록되어 있지 않아 본인 확인을 할 수 없습니다. 관리자에게 문의해 주세요.');
                    } else {
                        showToast('본인 계정이 아닙니다. 등록된 디스코드 계정으로 다시 시도해 주세요.');
                    }
                    state.pendingVerifyUser = null;
                    state.verifiedLoginUserId = null;
                    state.selectedLoginUserId = null;
                    renderAuthLoginView();
                    return;
                }

                const targetUser = verifyResult.user;

                let localUser = state.users.find(u => u.id === targetUser.id);
                if (!localUser) {
                    localUser = { id: targetUser.id, alias: targetUser.alias, discord: targetUser.discord, accounts: [], transactions: [] };
                    state.users.push(localUser);
                } else {
                    localUser.alias = targetUser.alias;
                    localUser.discord = targetUser.discord;
                }

                state.pendingVerifyUser = null;
                state.authMode = 'login';
                state.verifiedLoginUserId = targetUser.id;
                state.selectedLoginUserId = targetUser.id;
                rememberLoginUser(targetUser.id);
                state.enteredPin = '';
                renderAuthLoginView();
                showToast('본인 확인이 완료됐습니다. PIN을 입력해 주세요.');
            } catch (err) {
                console.error('디스코드 인증 처리 오류:', err);
                showToast('디스코드 인증 처리 중 오류가 발생했습니다.');
            }
        }

        const DISCORD_SIGNUP_FLAG_KEY = 'kdb_pay_discord_signup_pending';
        const DISCORD_SIGNUP_DRAFT_KEY = 'kdb_pay_discord_signup_draft';

        function extractDiscordIdentity(authUser) {
            const identity = (authUser.identities || []).find(i => i.provider === 'discord') || null;
            const data = (identity && identity.identity_data) || {};
            const meta = authUser.user_metadata || {};
            const numericId =
                (identity && identity.id) ||
                data.provider_id || data.sub ||
                meta.provider_id || meta.sub ||
                null;
            const rawName = data.name || data.preferred_username || data.user_name || data.full_name ||
                meta.name || meta.preferred_username || meta.user_name || meta.full_name || '';
            const username = String(rawName).replace(/#\d{1,4}$/, '').trim();
            return { numericId: numericId ? String(numericId) : null, username: username };
        }

        function updateSignupDiscordStatus() {
            const status = document.getElementById('signup-discord-status');
            const btn = document.getElementById('signup-discord-verify-btn');
            const input = document.getElementById('signup-discord');
            if (!status || !btn || !input) return;
            if (state.signupDiscordNumericId) {
                status.className = 'text-[10px] mt-1.5 text-emerald-400';
                status.innerHTML = '<i class="fa-solid fa-circle-check mr-1"></i>디스코드 연동 완료 · 숫자 ID가 자동으로 등록됩니다';
                btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 다시 연동';
                input.readOnly = true;
            } else {
                status.className = 'text-[10px] mt-1.5 text-zinc-500';
                status.innerText = '디스코드로 로그인하면 ID와 숫자 ID가 자동으로 입력·등록됩니다.';
                btn.innerHTML = '<i class="fa-brands fa-discord"></i> 연동';
                input.readOnly = false;
            }
        }

        async function startDiscordSignupLink() {
            const aliasInput = document.getElementById('signup-alias');
            const uidInput = document.getElementById('signup-uid');
            const btn = document.getElementById('signup-discord-verify-btn');
            try {
                if (btn) btn.disabled = true;
                localStorage.setItem(DISCORD_SIGNUP_FLAG_KEY, '1');
                localStorage.setItem(DISCORD_SIGNUP_DRAFT_KEY, JSON.stringify({
                    alias: aliasInput ? aliasInput.value : '',
                    uid: uidInput ? uidInput.value : ''
                }));
                const returnUrl = window.location.href.split('#')[0].split('?')[0];
                const { error } = await sbClient.auth.signInWithOAuth({
                    provider: 'discord',
                    options: { redirectTo: returnUrl }
                });
                if (error) {
                    console.error('디스코드 연동 시작 오류:', error);
                    showToast('디스코드 연동을 시작하지 못했습니다: ' + (error.message || ''));
                    localStorage.removeItem(DISCORD_SIGNUP_FLAG_KEY);
                    localStorage.removeItem(DISCORD_SIGNUP_DRAFT_KEY);
                    if (btn) btn.disabled = false;
                }
            } catch (err) {
                console.error('디스코드 연동 시작 오류:', err);
                showToast('디스코드 연동을 시작하지 못했습니다.');
                localStorage.removeItem(DISCORD_SIGNUP_FLAG_KEY);
                localStorage.removeItem(DISCORD_SIGNUP_DRAFT_KEY);
                if (btn) btn.disabled = false;
            }
        }

        async function handleDiscordSignupReturn() {
            if (!localStorage.getItem(DISCORD_SIGNUP_FLAG_KEY)) return;
            let draft = {};
            try { draft = JSON.parse(localStorage.getItem(DISCORD_SIGNUP_DRAFT_KEY)) || {}; } catch (e) { draft = {}; }
            localStorage.removeItem(DISCORD_SIGNUP_FLAG_KEY);
            localStorage.removeItem(DISCORD_SIGNUP_DRAFT_KEY);

            state.authMode = 'signup';
            state.signupDiscordNumericId = null;
            renderAuthLoginView();

            const aliasInput = document.getElementById('signup-alias');
            const uidInput = document.getElementById('signup-uid');
            const discordInput = document.getElementById('signup-discord');
            if (aliasInput && draft.alias) aliasInput.value = draft.alias;
            if (uidInput && draft.uid) uidInput.value = draft.uid;
            updateSignupDiscordStatus();

            try {
                const { data: sessionData, error: sessionError } = await sbClient.auth.getSession();
                const session = sessionData && sessionData.session;
                if (sessionError || !session || !session.user) {
                    showToast('디스코드 연동에 실패했습니다. 다시 시도해 주세요.');
                    return;
                }

                const found = extractDiscordIdentity(session.user);

                if (!found.numericId) {
                    showToast('디스코드 계정 정보를 확인하지 못했습니다.');
                    return;
                }

                const { data: signupAvailable, error: dupErr } = await sbClient.rpc('app_discord_signup_available');
                if (dupErr) {
                    console.error('디스코드 숫자 ID 중복 확인 오류:', dupErr);
                    showToast('디스코드 연동 확인 중 오류가 발생했습니다.');
                    return;
                }
                if (signupAvailable === false) {
                    showToast('이미 가입된 디스코드 계정입니다.');
                    return;
                }

                state.signupDiscordNumericId = found.numericId;
                if (discordInput && found.username) discordInput.value = found.username;
                updateSignupDiscordStatus();
                showToast('디스코드 연동이 완료됐습니다. 나머지 정보를 입력해 주세요.');
            } catch (err) {
                console.error('디스코드 연동 처리 오류:', err);
                showToast('디스코드 연동 처리 중 오류가 발생했습니다.');
            }
        }

        function pressPin(num) {
            if (state.enteredPin.length < 4) {
                state.enteredPin += num;
                updatePinDots();

                if (state.enteredPin.length === 4) {
                    setTimeout(verifyPinAndLogin, 150);
                }
            }
        }

        function backspacePin() {
            if (state.enteredPin.length > 0) {
                state.enteredPin = state.enteredPin.slice(0, -1);
                updatePinDots();
            }
        }

        function clearPin() {
            state.enteredPin = '';
            updatePinDots();
        }

        document.addEventListener('keydown', function(e) {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

            const isDigit = /^[0-9]$/.test(e.key);
            const isBackspace = e.key === 'Backspace';
            if (!isDigit && !isBackspace) return;

            const isVisible = (el) => !!el && el.getClientRects().length > 0;

            const authScreen = document.getElementById('auth-screen');
            const authPinSection = document.getElementById('auth-pin-section');
            if (authScreen && !authScreen.classList.contains('hidden-auth') && isVisible(authPinSection)) {
                e.preventDefault();
                if (isDigit) pressPin(e.key);
                else backspacePin();
                return;
            }

        });

        function updatePinDots() {
            const dots = document.querySelectorAll('.pin-dot');
            dots.forEach((dot, idx) => {
                if (idx < state.enteredPin.length) {
                    dot.className = 'pin-dot w-4 h-4 rounded-full bg-white border-2 border-white transition-all scale-110';
                } else {
                    dot.className = 'pin-dot w-4 h-4 rounded-full border-2 border-zinc-600 bg-transparent transition-all';
                }
            });
        }

        async function requestDiscordVerification(userId) {
            if (!VERIFICATION_API_BASE_URL) {
                showToast('본인인증 서버 주소가 설정되지 않았습니다. 관리자에게 문의해 주세요.');
                return false;
            }
            try {
                const response = await fetch(VERIFICATION_API_BASE_URL + '/api/request-verification', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: userId })
                });

                const result = await response.json().catch(() => ({}));

                if (!response.ok || !result.ok) {
                    console.error('Discord 본인인증 요청 오류:', result);
                    showToast(result.message || 'Discord 본인인증 요청에 실패했습니다.');
                    return false;
                }

                showToast('Discord DM으로 본인인증 링크를 보냈습니다.');
                return true;
            } catch (err) {
                console.error('Discord 본인인증 서버 연결 오류:', err);
                showToast('본인인증 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.');
                return false;
            }
        }

        let isVerifyingPin = false;

        async function verifyPinAndLogin() {
            if (isVerifyingPin) return;
            isVerifyingPin = true;
            try {
                await verifyPinAndLoginInner();
            } finally {
                isVerifyingPin = false;
            }
        }

        async function verifyPinAndLoginInner() {
            const targetUserId = state.verifiedLoginUserId;
            if (!targetUserId || targetUserId !== state.selectedLoginUserId) return;

            const enteredPin = state.enteredPin;
            if (!/^\d{4}$/.test(enteredPin)) return;

            let loginResult;
            try {
                const { data, error } = await sbClient.rpc('app_login', {
                    p_user_id: targetUserId,
                    p_pin: enteredPin
                });
                if (error) {
                    console.error('로그인 확인 오류:', error);
                    showToast('로그인 확인 중 오류가 발생했습니다.');
                    return;
                }
                loginResult = data;
            } catch (err) {
                console.error('로그인 확인 오류:', err);
                showToast('로그인 확인 중 오류가 발생했습니다.');
                return;
            }

            if (!loginResult || !loginResult.ok) {
                state.enteredPin = '';
                updatePinDots();
                const failReason = loginResult && loginResult.reason;
                if (failReason === 'discord_required' || failReason === 'discord_mismatch' || failReason === 'no_discord_id') {
                    forgetRememberedLoginUser();
                    state.pendingVerifyUser = null;
                    state.verifiedLoginUserId = null;
                    state.selectedLoginUserId = null;
                    try { await sbClient.auth.signOut(); } catch (e) {}
                    renderAuthLoginView();
                    showToast(failReason === 'no_discord_id'
                        ? '이 계정에는 디스코드 숫자 ID가 등록되어 있지 않습니다. 관리자에게 문의해 주세요.'
                        : '디스코드 본인 확인이 필요합니다. 계정을 다시 찾아 인증해 주세요.');
                    return;
                }
                if (failReason === 'locked') {
                    const secs = Number(loginResult.seconds_remaining) || 0;
                    if (secs > 0) {
                        const mins = Math.max(1, Math.ceil(secs / 60));
                        showToast('로그인 5회 실패로 잠겨 있습니다. ' + mins + '분 후 다시 시도해 주세요.');
                    } else {
                        showToast('로그인 5회 실패로 5분 동안 로그인 시도가 제한됩니다.');
                    }
                } else {
                    showToast('PIN 번호가 일치하지 않습니다.');
                }
                return;
            }

            const row = loginResult.user;
            state.sessionToken = loginResult.token;

            let localUser = state.users.find(u => u.id === row.id);
            if (!localUser) {
                localUser = { id: row.id, accounts: [], transactions: [] };
                state.users.push(localUser);
            }
            localUser.alias = row.alias;
            localUser.discord = row.discord;
            localUser.uid = row.uid;
            localUser.points = row.points || 0;
            localUser.currentAccountId = row.current_account_id;
            localUser.sessionAccountId = null;
            localUser.attendanceHistory = row.attendance_history || {};
            localUser.purchasedItems = row.purchased_items || [];
            localUser.isAdmin = row.is_admin || false;
            localUser.isFrozen = row.is_frozen || false;
            localUser.discordNumericId = row.discord_numeric_id || '';

            state.currentUserId = row.id;
            state.verifiedLoginUserId = null;
            state.selectedLoginUserId = null;
            addKnownAccountId(row.id);
            showToast('계좌 정보를 불러오는 중입니다...');
            await runInterestCatchup();
            await loadUserFinancialData(row.id);
            saveAppData();
            subscribeToRealtimeUpdates();
            document.getElementById('auth-screen').classList.add('hidden-auth');
            renderApp();
            showToast(row.alias + '님 환영합니다!');
            runDueAutoTransfers();
        }

        async function executeSignup() {
            const aliasInput = document.getElementById('signup-alias');
            const discordInput = document.getElementById('signup-discord');
            const uidInput = document.getElementById('signup-uid');
            const pinInput = document.getElementById('signup-pin');

            const alias = aliasInput ? aliasInput.value.trim() : '';
            const discord = discordInput ? discordInput.value.trim() : '';
            const uid = uidInput ? uidInput.value.trim() : '';
            const pin = pinInput ? pinInput.value.trim() : '';

            if (!alias || !discord || !uid || !pin) {
                showToast('모든 가입 필수 정보를 입력해 주세요.');
                return;
            }

            if (pin.length < 4) {
                showToast('PIN 비밀번호 4자리를 모두 입력하세요.');
                return;
            }

            if (!isValidAlias(alias)) {
                showToast('가명은 20자 이하로, 특수문자(< > \" \' ` \\) 없이 입력해 주세요.');
                return;
            }

            if (!state.signupDiscordNumericId) {
                showToast('디스코드 ID 옆의 [연동] 버튼으로 디스코드 계정을 먼저 연동해 주세요.');
                return;
            }

            const signupBtn = document.getElementById('signup-submit-btn');
            if (signupBtn) signupBtn.disabled = true;

            let newUserId, newAccountId, newAccNo, newDiscordNumericId;
            try {
                const { data, error } = await sbClient.rpc('app_signup', {
                    p_alias: alias, p_discord: discord, p_uid: uid, p_pin: pin
                });
                if (error) {
                    const msg = error.message || '';
                    if (msg.includes('discord_taken')) {
                        showToast('이미 가입된 디스코드 ID입니다.');
                    } else if (msg.includes('uid_taken')) {
                        showToast('이미 사용 중인 고유번호입니다. 다른 번호를 입력해 주세요.');
                    } else if (msg.includes('discord_required')) {
                        showToast('디스코드 연동이 필요합니다. 디스코드 연동 버튼을 눌러 다시 인증해 주세요.');
                        state.signupDiscordNumericId = null;
                        updateSignupDiscordStatus();
                    } else if (msg.includes('invalid_alias')) {
                        showToast('가명은 20자 이하로, 특수문자(< > \" \' ` \\) 없이 입력해 주세요.');
                    } else {
                        console.error('회원가입 오류:', error);
                        showToast('가입 처리 중 오류가 발생했습니다. 다시 시도해 주세요.');
                    }
                    if (signupBtn) signupBtn.disabled = false;
                    return;
                }
                if (!data || !data.ok || !data.account) throw new Error('signup_failed');
                newUserId = data.user_id;
                newAccountId = data.account.id;
                newAccNo = data.account.account_no;
                newDiscordNumericId = data.discord_numeric_id || null;
                state.sessionToken = data.token;
            } catch (err) {
                console.error('회원가입 오류:', err);
                showToast('가입 처리 중 오류가 발생했습니다. 다시 시도해 주세요.');
                if (signupBtn) signupBtn.disabled = false;
                return;
            }

            if (signupBtn) signupBtn.disabled = false;

            const newUser = {
                id: newUserId,
                alias: alias,
                discord: discord,
                uid: uid,
                points: 1000,
                currentAccountId: newAccountId,
                accounts: [
                    { id: newAccountId, name: 'KDB페이 주계좌', accountNo: newAccNo, balance: 100000 }
                ],
                transactions: [
                    { id: 'tx-init-' + newUserId, accountId: newAccountId, title: '신규 가입 웰컴 지원금', counterparty: 'KDB Pay', date: '방금 전',
                    createdAt: new Date().toISOString(), amount: 100000, type: 'deposit' }
                ],
                attendanceHistory: {},
                purchasedItems: [],
                discordNumericId: newDiscordNumericId || state.signupDiscordNumericId
            };

            state.users.push(newUser);
            state.hasUsers = true;
            state.currentUserId = newUser.id;
            state.signupDiscordNumericId = null;
            updateSignupDiscordStatus();
            addKnownAccountId(newUser.id);
            saveAppData();
            subscribeToRealtimeUpdates();

            document.getElementById('auth-screen').classList.add('hidden-auth');
            renderApp();
            showToast('회원가입 완료! 웰컴 지원금 100,000원이 입금되었습니다.');
        }

        function logout() {
            if (state.currentMerchantId || state.merchantToken) {
                try { logoutMerchant(); } catch (e) {}
            }
            const tokenToRevoke = state.sessionToken;
            state.sessionToken = null;
            if (tokenToRevoke) sbClient.rpc('app_logout', { p_token: tokenToRevoke }).then(() => {}, () => {});
            try { sbClient.auth.signOut().then(() => {}, () => {}); } catch (e) {}
            state.currentUserId = null;
            state.enteredPin = '';
            saveAppData();
            closeAccountDetail();
            unsubscribeRealtimeUpdates();
            stopPayCodeAutoRefresh();
            hidePaymentRequestBanner();
            const badge = document.getElementById('notif-badge');
            if (badge) badge.classList.add('hidden');
            document.getElementById('auth-screen').classList.remove('hidden-auth');
            state.authMode = 'login';
            renderAuthLoginView();
            showToast('안전하게 로그아웃 되었습니다.');
        }

        function renderApp() {
            const user = getCurrentUser();
            if (!user) return;

            const activeAcc = getActiveAccount();

            document.getElementById('home-user-alias').innerText = user.alias + ' 님';
            document.getElementById('mypage-user-alias').innerText = user.alias;
            document.getElementById('mypage-user-discord').innerText = user.discord + ' (UID: ' + user.uid + ')';
            document.getElementById('mypage-avatar-icon').innerText = user.alias.charAt(0);

            const adminMenuItem = document.getElementById('admin-menu-item');
            if (adminMenuItem) {
                if (user.isAdmin) adminMenuItem.classList.remove('hidden');
                else adminMenuItem.classList.add('hidden');
            }

            if (activeAcc) {
                document.getElementById('home-account-type').innerText = activeAcc.name;
                document.getElementById('home-account-no').innerText = activeAcc.accountNo;
                document.getElementById('home-account-uid').innerText = 'UID ' + user.uid;
                animateNumberChange(document.getElementById('main-balance'), activeAcc.balance);
                document.getElementById('pay-account-no').innerText = activeAcc.name + ' (' + activeAcc.accountNo + ')';
            }

            document.getElementById('shop-user-points').innerText = formatNumber(user.points || 0);
            document.getElementById('user-points-display').innerText = formatNumber(user.points || 0);

            renderHomeAccountList();
            renderHomeMonthSpend();
            refreshAccountDetail();
            renderAttendanceWidget();
            renderShopGrid();
        }

        let homeAccountEditMode = false;
        let accDrag = null;

        function syncHomeReorderFooter() {
            const user = getCurrentUser();
            const count = user ? (user.accounts || []).length : 0;
            if (count < 2) homeAccountEditMode = false;

            const seeAll = document.getElementById('home-see-all-btn');
            const hint = document.getElementById('home-reorder-hint');
            const btn = document.getElementById('home-reorder-btn');
            if (seeAll) seeAll.classList.toggle('hidden', homeAccountEditMode);
            if (hint) hint.classList.toggle('hidden', !homeAccountEditMode);
            if (btn) {
                btn.innerHTML = homeAccountEditMode ? '완료' : '<i class="fa-solid fa-sort mr-1"></i>순서 변경';
                btn.className = 'text-center text-xs py-3 border-l border-zinc-100 cursor-pointer hover:bg-zinc-50 transition-colors ' +
                    (homeAccountEditMode ? 'px-6 font-bold text-zinc-900' : 'flex-1 font-semibold text-zinc-400 hover:text-zinc-600') +
                    (count < 2 ? ' hidden' : '');
            }
        }

        function toggleHomeAccountReorder() {
            const user = getCurrentUser();
            if (!user || (user.accounts || []).length < 2) return;
            homeAccountEditMode = !homeAccountEditMode;
            renderHomeAccountList();
        }

        function renderHomeAccountList() {
            if (accDrag) return;

            const user = getCurrentUser();
            const container = document.getElementById('home-account-list');
            if (!user || !container) return;

            syncHomeReorderFooter();

            if (!user.accounts || user.accounts.length === 0) {
                container.innerHTML = '';
                return;
            }

            const primary = getPrimaryAccount();
            const primaryId = primary ? primary.id : null;
            const prevBalances = state.homeBalanceSnapshot || {};

            container.innerHTML = user.accounts.map((acc, idx) => {
                const borderClass = idx === 0 ? '' : 'border-t border-zinc-100';
                const shownBalance = Object.prototype.hasOwnProperty.call(prevBalances, acc.id) ? prevBalances[acc.id] : acc.balance;
                const primaryBadge = (acc.id === primaryId
                    ? '<span class="ml-1.5 text-[9px] font-bold text-white bg-zinc-900 px-1.5 py-0.5 rounded-full align-middle">주계좌</span>'
                    : '') + (acc.accountType === 'savings' && user.interest && user.interest.enabled
                    ? '<span class="ml-1.5 text-[9px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full align-middle">월 ' + formatInterestPct(user.interest.monthly_rate) + '%</span>'
                    : '');
                const rightSide = homeAccountEditMode
                    ? '<div class="acc-drag-handle shrink-0 ml-2 -mr-2 w-11 h-11 flex items-center justify-center text-zinc-400 rounded-xl hover:bg-zinc-100" onpointerdown="startAccountDrag(event, this, \'home-account-list\', \'.home-acc-row\')" aria-label="끌어서 순서 변경"><i class="fa-solid fa-grip-lines text-base"></i></div>'
                    : '<div class="flex items-center gap-1.5 shrink-0 ml-2">' +
                        '<button onclick="event.stopPropagation();copyAccountNo(' + jsArg(acc.id) + ')" aria-label="계좌번호 복사" class="w-8 h-8 flex items-center justify-center text-zinc-500 bg-zinc-100 rounded-lg hover:bg-zinc-200 transition-colors"><i class="fa-regular fa-copy text-xs"></i></button>' +
                        '<button onclick="event.stopPropagation();quickTransferFromAccount(' + jsArg(acc.id) + ')" class="text-xs font-bold text-zinc-600 bg-zinc-100 px-3.5 py-2 rounded-lg hover:bg-zinc-200 transition-colors">송금</button>' +
                      '</div>';

                return '<div class="home-acc-row flex items-center justify-between px-4 py-3.5 ' + borderClass + (homeAccountEditMode ? '' : ' cursor-pointer active:bg-zinc-50') + '" data-acc-id="' + acc.id + '"' + (homeAccountEditMode ? '' : ' onclick="openAccountDetail(' + jsArg(acc.id) + ')"') + '>' +
                    '<div class="flex items-center gap-3 min-w-0">' +
                        '<div class="w-9 h-9 rounded-full bg-zinc-900 flex items-center justify-center shrink-0">' +
                            '<i class="fa-solid fa-won-sign text-white text-xs"></i>' +
                        '</div>' +
                        '<div class="min-w-0">' +
                            '<div class="font-extrabold text-sm text-zinc-900"><span class="home-acc-balance roll-number" data-acc-balance="' + acc.id + '">' + formatNumber(shownBalance) + '</span>원' + primaryBadge + '</div>' +
                            '<div class="text-[11px] text-zinc-400 mt-0.5 truncate">' + escapeHtml(acc.name) + ' · <span class="font-mono">' + escapeHtml(acc.accountNo) + '</span></div>' +
                        '</div>' +
                    '</div>' +
                    rightSide +
                '</div>';
            }).join('');

            const nextSnapshot = {};
            user.accounts.forEach(acc => {
                nextSnapshot[acc.id] = acc.balance;
                const el = container.querySelector('[data-acc-balance="' + acc.id + '"]');
                if (!el) return;
                if (Object.prototype.hasOwnProperty.call(prevBalances, acc.id) && prevBalances[acc.id] !== acc.balance) {
                    rollNumber(el, prevBalances[acc.id], acc.balance);
                }
            });
            state.homeBalanceSnapshot = nextSnapshot;
        }

        function startAccountDrag(e, handleEl, listId, rowSelector) {
            if (accDrag) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;

            const list = document.getElementById(listId);
            if (!list) return;
            const rows = Array.from(list.querySelectorAll(rowSelector));
            const from = rows.findIndex(r => r.contains(handleEl));
            if (from < 0 || rows.length < 2) return;

            e.preventDefault();
            try { handleEl.setPointerCapture(e.pointerId); } catch (err) {}

            const scroller = handleEl.closest('.modal-card, .tab-content');
            const rects = rows.map(r => r.getBoundingClientRect());
            accDrag = {
                pointerId: e.pointerId,
                handleEl: handleEl,
                rows: rows,
                rects: rects,
                gap: Math.max(0, rects[1].top - rects[0].bottom),
                from: from,
                to: from,
                startY: e.clientY,
                lastY: e.clientY,
                scroller: scroller,
                inTab: !!(scroller && scroller.classList.contains('tab-content')),
                scrollStart: scroller ? scroller.scrollTop : 0,
                raf: null
            };

            rows.forEach((r, i) => r.classList.add(i === from ? 'dragging' : 'shifting'));

            handleEl.addEventListener('pointermove', onAccountDragMove);
            handleEl.addEventListener('pointerup', onAccountDragEnd);
            handleEl.addEventListener('pointercancel', onAccountDragEnd);
        }

        function onAccountDragMove(e) {
            const d = accDrag;
            if (!d || e.pointerId !== d.pointerId) return;
            d.lastY = e.clientY;
            updateAccountDrag();
            if (!d.raf) d.raf = requestAnimationFrame(accountDragAutoScroll);
        }

        function updateAccountDrag() {
            const d = accDrag;
            if (!d) return;

            const scrollDelta = d.scroller ? d.scroller.scrollTop - d.scrollStart : 0;
            const from = d.from;
            const last = d.rows.length - 1;
            const h = d.rects[from].height;
            const step = h + d.gap;

            const minDy = d.rects[0].top - d.rects[from].top;
            const maxDy = d.rects[last].bottom - d.rects[from].bottom;
            const dy = Math.max(minDy, Math.min(maxDy, d.lastY - d.startY + scrollDelta));

            d.rows[from].style.transform = 'translateY(' + dy + 'px)';

            const center = d.rects[from].top + h / 2 + dy;
            let to = 0;
            d.rects.forEach((r, i) => {
                if (i !== from && r.top + r.height / 2 < center) to++;
            });
            d.to = to;

            d.rows.forEach((row, i) => {
                if (i === from) return;
                let shift = 0;
                if (from < to && i > from && i <= to) shift = -step;
                else if (from > to && i >= to && i < from) shift = step;
                row.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
            });
        }

        function accountDragAutoScroll() {
            const d = accDrag;
            if (!d) return;
            d.raf = null;
            if (!d.scroller) return;

            const box = d.scroller.getBoundingClientRect();
            const topEdge = box.top + (d.inTab ? 70 : 50);
            const bottomEdge = box.bottom - (d.inTab ? 130 : 50);
            let speed = 0;
            if (d.lastY < topEdge) speed = -Math.min(14, (topEdge - d.lastY) / 5 + 2);
            else if (d.lastY > bottomEdge) speed = Math.min(14, (d.lastY - bottomEdge) / 5 + 2);

            if (speed !== 0) {
                const before = d.scroller.scrollTop;
                d.scroller.scrollTop = before + speed;
                if (d.scroller.scrollTop !== before) {
                    updateAccountDrag();
                    d.raf = requestAnimationFrame(accountDragAutoScroll);
                }
            }
        }

        function onAccountDragEnd(e) {
            const d = accDrag;
            if (!d || e.pointerId !== d.pointerId) return;

            d.handleEl.removeEventListener('pointermove', onAccountDragMove);
            d.handleEl.removeEventListener('pointerup', onAccountDragEnd);
            d.handleEl.removeEventListener('pointercancel', onAccountDragEnd);
            try { d.handleEl.releasePointerCapture(d.pointerId); } catch (err) {}
            if (d.raf) cancelAnimationFrame(d.raf);

            d.rows.forEach(r => {
                r.classList.remove('dragging', 'shifting');
                r.style.transform = '';
            });

            const from = d.from;
            const to = e.type === 'pointercancel' ? from : d.to;
            accDrag = null;

            const user = getCurrentUser();
            if (user && to !== from) {
                const moved = user.accounts.splice(from, 1)[0];
                user.accounts.splice(to, 0, moved);
                persistAccountOrder(user);
            }
            renderHomeAccountList();
            const selectorModal = document.getElementById('modal-account-selector');
            if (selectorModal && !selectorModal.classList.contains('hidden-modal')) renderAccountSelectorList();
        }

        function quickTransferFromAccount(accId) {
            const user = getCurrentUser();
            if (!user) return;
            if (user.sessionAccountId !== accId) {
                user.sessionAccountId = accId;
                renderApp();
            }
            openTransferModal();
        }

        function renderHomeMonthSpend() {
            const user = getCurrentUser();
            const elem = document.getElementById('home-month-spend');
            if (!user || !elem) return;

            const now = new Date();
            const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
            let total = 0;
            (user.transactions || []).forEach(tx => {
                if (tx.amount < 0 && tx.createdAt && tx.createdAt.slice(0, 7) === ym) {
                    total += -tx.amount;
                }
            });
            elem.innerText = formatNumber(total) + '원';
        }

        function renderTxItemsHtml(transactions) {
            return transactions.map(tx => {
                const isPositive = tx.amount > 0;
                const amtClass = isPositive ? 'text-emerald-600 font-extrabold' : (tx.amount < 0 ? 'text-zinc-900 font-extrabold' : 'text-zinc-500 font-semibold');
                const sign = isPositive ? '+' : '';
                const memoHtml = tx.memo ? '<div class="text-[10px] text-zinc-500 mt-1 italic">"' + escapeHtml(tx.memo) + '"</div>' : '';
                const displayDate = escapeHtml(tx.createdAt ? formatRelativeDate(tx.createdAt) : tx.date);

                return '<div class="bg-white p-3.5 rounded-2xl border border-zinc-200/80 shadow-sm flex justify-between items-center">' +
                    '<div>' +
                        '<div class="font-bold text-xs text-zinc-900">' + escapeHtml(tx.title) + '</div>' +
                        '<div class="text-[10px] text-zinc-400 mt-0.5">' + displayDate + '</div>' +
                        memoHtml +
                    '</div>' +
                    '<div class="' + amtClass + ' text-sm">' + sign + formatNumber(tx.amount) + '원</div>' +
                '</div>';
            }).join('');
        }

        function openAccountDetail(accId) {
            const user = getCurrentUser();
            if (!user || homeAccountEditMode) return;
            const acc = (user.accounts || []).find(a => a.id === accId);
            if (!acc) return;
            state.accountDetailId = accId;
            renderAccountDetail();
            const listEl = document.getElementById('acc-detail-tx-list');
            if (listEl) listEl.scrollTop = 0;
            openModal('modal-account-detail');
        }

        function closeAccountDetail() {
            state.accountDetailId = null;
            closeModal('modal-account-detail');
        }

        function renderAccountDetail() {
            const user = getCurrentUser();
            if (!user || !state.accountDetailId) return;

            const acc = (user.accounts || []).find(a => a.id === state.accountDetailId);
            if (!acc) {
                closeAccountDetail();
                return;
            }

            const primary = getPrimaryAccount();
            document.getElementById('acc-detail-name').innerText = acc.name;
            document.getElementById('acc-detail-primary').classList.toggle('hidden', !(primary && primary.id === acc.id));
            document.getElementById('acc-detail-frozen').classList.toggle('hidden', !acc.isFrozen);
            document.getElementById('acc-detail-balance').innerText = formatNumber(acc.balance);
            document.getElementById('acc-detail-no').innerText = acc.accountNo;

            const interestBox = document.getElementById('acc-detail-interest');
            if (interestBox) {
                const cfg = user.interest;
                if (acc.accountType === 'savings' && cfg && cfg.enabled) {
                    const expected = computeExpectedInterest(user)[acc.id] || 0;
                    const next = cfg.next_payout ? new Date(cfg.next_payout) : null;
                    const nextText = next && !isNaN(next.getTime())
                        ? next.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
                        : '다음 달 1일';
                    document.getElementById('acc-detail-interest-title').innerText = '매월 ' + formatInterestPct(cfg.monthly_rate) + '% 이자';
                    document.getElementById('acc-detail-interest-text').innerText =
                        '내 적금 계좌 합계 최대 ' + formatNumber(cfg.balance_cap) + '원까지 이자가 붙어요. ' +
                        nextText + ' 지급 예정 이자는 약 ' + formatNumber(expected) + '원이에요.';
                    interestBox.classList.remove('hidden');
                } else {
                    interestBox.classList.add('hidden');
                }
            }

            const txs = (user.transactions || []).filter(t => t.accountId === acc.id);
            document.getElementById('acc-detail-tx-count').innerText = txs.length + '건';

            const listEl = document.getElementById('acc-detail-tx-list');
            const prevScroll = listEl.scrollTop;
            listEl.innerHTML = txs.length
                ? renderTxItemsHtml(txs)
                : '<div class="text-center py-10 text-xs text-zinc-400">이 계좌의 거래 내역이 없어요.</div>';
            listEl.scrollTop = prevScroll;
        }

        function refreshAccountDetail() {
            if (!state.accountDetailId) return;
            const modal = document.getElementById('modal-account-detail');
            if (!modal || modal.classList.contains('hidden-modal')) return;
            renderAccountDetail();
        }

        function copyAccountDetailNo() {
            if (state.accountDetailId) copyAccountNo(state.accountDetailId);
        }

        function fillFromAccountDetail() {
            const accId = state.accountDetailId;
            if (!accId) return;
            closeAccountDetail();
            openDepositModal(accId);
        }

        function sendFromAccountDetail() {
            const accId = state.accountDetailId;
            if (!accId) return;
            closeAccountDetail();
            quickTransferFromAccount(accId);
        }

        const SHOP_CATEGORIES = ['디지털', '푸드', '패션', '생활', '기타'];
        const SHOP_POINT_RATE = 0.5;

        state.shopProducts = [];
        state.shopLoaded = false;
        state.shopLoading = false;
        state.shopLoadedAt = 0;
        state.shopQuery = '';
        state.shopCategory = '전체';
        state.shopBuy = null;
        state.shopBuying = false;
        state.portalSection = 'dashboard';
        state.merchantProducts = [];
        state.merchantOrders = [];
        state.portalImage = '';
        let shopSearchTimer = null;

        function safeImageSrc(src) {
            return typeof src === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(src) ? src : '';
        }

        function renderShopCategoryChips() {
            const box = document.getElementById('shop-category-chips');
            if (!box) return;
            box.innerHTML = ['전체'].concat(SHOP_CATEGORIES).map(cat => {
                const active = state.shopCategory === cat;
                return '<button onclick="setShopCategory(' + jsArg(cat) + ')" class="shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ' +
                    (active ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50') + '">' + escapeHtml(cat) + '</button>';
            }).join('');
        }

        function setShopCategory(cat) {
            state.shopCategory = cat;
            renderShopCategoryChips();
            loadShopProducts(true);
        }

        function onShopSearchInput() {
            clearTimeout(shopSearchTimer);
            shopSearchTimer = setTimeout(() => {
                const input = document.getElementById('shop-search-input');
                state.shopQuery = input ? input.value.trim() : '';
                loadShopProducts(true);
            }, 350);
        }

        async function loadShopProducts(force) {
            if (!getCurrentUser() || !state.sessionToken) return;
            if (state.shopLoading) return;
            if (!force && state.shopLoaded && Date.now() - state.shopLoadedAt < 20000) return;

            state.shopLoading = true;
            renderShopGrid();
            try {
                const { data, error } = await authRpc('app_list_products', {
                    p_query: state.shopQuery || null,
                    p_category: state.shopCategory === '전체' ? null : state.shopCategory,
                    p_limit: 60,
                    p_offset: 0
                });
                if (error) {
                    console.error('상품 목록 조회 오류:', error);
                    showToast('상품 목록을 불러오지 못했습니다.');
                } else {
                    state.shopProducts = Array.isArray(data) ? data : [];
                    state.shopLoaded = true;
                    state.shopLoadedAt = Date.now();
                }
            } catch (err) {
                console.error('상품 목록 조회 오류:', err);
            }
            state.shopLoading = false;
            renderShopGrid();
        }

        function renderShopGrid() {
            const grid = document.getElementById('shop-products-grid');
            if (!grid) return;

            renderShopCategoryChips();

            if (state.shopLoading && !state.shopProducts.length) {
                grid.innerHTML = '<div class="col-span-2 text-center py-10 text-xs text-zinc-400">상품을 불러오는 중입니다...</div>';
                return;
            }

            if (!state.shopProducts.length) {
                grid.innerHTML =
                    '<div class="col-span-2 bg-white rounded-2xl p-10 border border-zinc-200/80 shadow-sm flex flex-col items-center justify-center text-center my-2">' +
                        '<div class="w-14 h-14 bg-zinc-100 text-zinc-400 rounded-full flex items-center justify-center mb-3 text-2xl border border-zinc-200">' +
                            '<i class="fa-solid fa-box-open"></i>' +
                        '</div>' +
                        '<p class="text-zinc-800 font-bold text-sm">' + (state.shopQuery || state.shopCategory !== '전체' ? '조건에 맞는 상품이 없습니다' : '등록된 상품이 없습니다') + '</p>' +
                        '<p class="text-zinc-400 text-xs mt-1 leading-relaxed">새로운 상품이 등록되면 이곳에 표시돼요.</p>' +
                    '</div>';
                return;
            }

            grid.innerHTML = state.shopProducts.map(p => {
                const img = safeImageSrc(p.image);
                const soldOut = p.stock !== null && p.stock !== undefined && p.stock <= 0;
                const imgHtml = img
                    ? '<img src="' + img + '" alt="" class="w-full h-full object-cover">'
                    : '<i class="fa-regular fa-image text-2xl text-zinc-300"></i>';
                return '<button onclick="openShopProduct(' + jsArg(p.id) + ')" class="text-left bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden active:scale-[0.98] transition-transform">' +
                    '<div class="relative aspect-square bg-zinc-100 flex items-center justify-center overflow-hidden">' + imgHtml +
                        (soldOut ? '<div class="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-xs font-bold">품절</div>' : '') +
                    '</div>' +
                    '<div class="p-3">' +
                        '<div class="text-[10px] text-zinc-400 font-semibold truncate">' + escapeHtml(p.merchant_name) + '</div>' +
                        '<div class="text-xs font-bold text-zinc-900 mt-0.5 line-clamp-2 break-words">' + escapeHtml(p.name) + '</div>' +
                        '<div class="text-sm font-extrabold text-zinc-900 mt-1.5">' + formatNumber(p.price) + '원</div>' +
                    '</div>' +
                '</button>';
            }).join('');
        }

        function openShopProduct(productId) {
            const user = getCurrentUser();
            const product = state.shopProducts.find(p => p.id === productId);
            if (!user || !product) return;

            state.shopBuy = { product: product, qty: 1, requestBase: genRequestId() };

            const img = safeImageSrc(product.image);
            document.getElementById('shop-detail-image').innerHTML = img
                ? '<img src="' + img + '" alt="" class="w-full h-full object-cover">'
                : '<i class="fa-regular fa-image"></i>';
            document.getElementById('shop-detail-merchant').innerText = product.merchant_name;
            document.getElementById('shop-detail-name').innerText = product.name;
            document.getElementById('shop-detail-price').innerText = formatNumber(product.price) + '원';
            document.getElementById('shop-detail-desc').innerText = product.description || '상품 설명이 없습니다.';
            const soldOut = product.stock !== null && product.stock !== undefined && product.stock <= 0;
            document.getElementById('shop-detail-stock').innerText = product.stock === null || product.stock === undefined
                ? '재고 넉넉함' : (soldOut ? '품절된 상품입니다' : '남은 수량 ' + formatNumber(product.stock) + '개');

            const select = document.getElementById('shop-buy-account');
            const primary = getPrimaryAccount();
            select.innerHTML = user.accounts.map(acc =>
                '<option value="' + escapeHtml(acc.id) + '"' + (primary && primary.id === acc.id ? ' selected' : '') + '>' +
                escapeHtml(acc.name) + ' · ' + formatNumber(acc.balance) + '원' + (acc.isFrozen ? ' (정지)' : '') + '</option>'
            ).join('');

            document.getElementById('shop-detail-qty').innerText = '1';
            document.getElementById('shop-use-points').checked = false;
            openModal('modal-shop-product');
            updateShopTotals();
        }

        function closeShopProduct() {
            state.shopBuy = null;
            closeModal('modal-shop-product');
        }

        function changeShopQty(delta) {
            const buy = state.shopBuy;
            if (!buy) return;
            const stock = buy.product.stock;
            const max = stock === null || stock === undefined ? 99 : Math.max(1, Math.min(99, stock));
            buy.qty = Math.min(max, Math.max(1, buy.qty + delta));
            document.getElementById('shop-detail-qty').innerText = String(buy.qty);
            updateShopTotals();
        }

        function computeShopTotals() {
            const user = getCurrentUser();
            const buy = state.shopBuy;
            if (!user || !buy) return null;
            const total = buy.product.price * buy.qty;
            const usePoints = document.getElementById('shop-use-points').checked;
            const maxByRate = Math.floor(total * SHOP_POINT_RATE);
            const have = Math.max(0, user.points || 0);
            const points = usePoints ? Math.min(have, maxByRate) : 0;
            return { total: total, points: points, paid: total - points, maxByRate: maxByRate, have: have };
        }

        function updateShopTotals() {
            const user = getCurrentUser();
            const buy = state.shopBuy;
            const t = computeShopTotals();
            if (!user || !buy || !t) return;

            document.getElementById('shop-sum-total').innerText = formatNumber(t.total) + '원';
            document.getElementById('shop-sum-points').innerText = '-' + formatNumber(t.points) + '원';
            document.getElementById('shop-sum-paid').innerText = formatNumber(t.paid) + '원';
            document.getElementById('shop-points-hint').innerText = '보유 ' + formatNumber(t.have) + 'P · 결제 금액의 최대 ' + Math.round(SHOP_POINT_RATE * 100) + '%까지 (1P = 1원)';

            const accId = document.getElementById('shop-buy-account').value;
            const acc = user.accounts.find(a => a.id === accId);
            const soldOut = buy.product.stock !== null && buy.product.stock !== undefined && buy.product.stock <= 0;

            const warn = document.getElementById('shop-sum-warning');
            const btn = document.getElementById('shop-buy-btn');
            let message = '';
            if (soldOut) message = '품절된 상품입니다.';
            else if (!acc) message = '결제 계좌를 선택해 주세요.';
            else if (acc.isFrozen) message = '정지된 계좌로는 결제할 수 없습니다.';
            else if (acc.balance < t.paid) message = '계좌 잔액이 부족합니다.';

            warn.innerText = message;
            warn.classList.toggle('hidden', !message);
            btn.disabled = !!message || state.shopBuying;
            btn.innerText = message ? '구매할 수 없습니다' : formatNumber(t.paid) + '원 결제하기';
        }

        async function confirmShopPurchase() {
            if (state.shopBuying) return;
            const user = getCurrentUser();
            const buy = state.shopBuy;
            const t = computeShopTotals();
            if (!user || !buy || !t) return;

            const accId = document.getElementById('shop-buy-account').value;
            const usePoints = document.getElementById('shop-use-points').checked;

            state.shopBuying = true;
            const btn = document.getElementById('shop-buy-btn');
            btn.disabled = true;
            btn.innerText = '결제 중...';

            let result = null;
            try {
                const { data, error } = await authRpc('app_buy_product', {
                    p_product_id: buy.product.id,
                    p_account_id: accId,
                    p_quantity: buy.qty,
                    p_use_points: usePoints,
                    p_request_id: buy.requestBase + ':' + accId + ':' + buy.qty + ':' + (usePoints ? 1 : 0)
                });
                if (error) {
                    console.error('상품 구매 오류:', error);
                } else {
                    result = data;
                }
            } catch (err) {
                console.error('상품 구매 오류:', err);
            }

            state.shopBuying = false;

            if (!result || !result.ok) {
                const msg = {
                    insufficient_balance: '계좌 잔액이 부족합니다.',
                    out_of_stock: '재고가 부족합니다.',
                    product_unavailable: '판매가 중단된 상품입니다.',
                    frozen: '정지된 계좌로는 결제할 수 없습니다.',
                    invalid_account: '결제 계좌를 확인해 주세요.',
                    invalid_quantity: '수량을 확인해 주세요.'
                }[result && result.reason] || '구매 처리 중 오류가 발생했습니다.';
                showToast(msg);
                updateShopTotals();
                if (result && (result.reason === 'out_of_stock' || result.reason === 'product_unavailable')) {
                    closeShopProduct();
                    loadShopProducts(true);
                }
                return;
            }

            const name = buy.product.name;
            closeShopProduct();
            showToast(name + ' 구매가 완료되었습니다. (' + formatNumber(result.paid_amount) + '원)');

            try {
                await loadUserFinancialData(user.id);
            } catch (err) {
                console.error('구매 후 데이터 갱신 오류:', err);
            }
            const refreshed = getCurrentUser();
            if (refreshed) {
                const acc = refreshed.accounts.find(a => a.id === accId);
                if (acc && typeof result.new_balance === 'number') acc.balance = result.new_balance;
                refreshed.points = Math.max(0, (refreshed.points || 0) - (result.points_used || 0));
            }
            renderApp();
            refreshNotifBadge();
            loadShopProducts(true);
        }

        function orderStatusLabel(status) {
            return { paid: '결제 완료', completed: '수령 완료', cancelled: '취소·환불' }[status] || status;
        }

        function orderStatusClass(status) {
            return {
                paid: 'bg-amber-50 text-amber-700 border-amber-200',
                completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                cancelled: 'bg-zinc-100 text-zinc-500 border-zinc-200'
            }[status] || 'bg-zinc-100 text-zinc-500 border-zinc-200';
        }

        async function openCartModal() {
            const user = getCurrentUser();
            const listContainer = document.getElementById('cart-items-list');
            if (!user || !listContainer) return;

            listContainer.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">불러오는 중...</div>';
            openModal('modal-cart');

            const { data, error } = await authRpc('app_list_my_orders', { p_limit: 50 });
            if (error) {
                listContainer.innerHTML = '<div class="text-center py-6 text-xs text-red-500 bg-red-50 rounded-xl border border-red-100">구매 내역을 불러오지 못했습니다.</div>';
                return;
            }

            const orders = Array.isArray(data) ? data : [];
            if (!orders.length) {
                listContainer.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400 bg-zinc-50 rounded-xl border border-zinc-200">구매한 상품 내역이 없습니다.</div>';
                return;
            }

            listContainer.innerHTML = orders.map(o =>
                '<div class="bg-white p-3.5 rounded-xl border border-zinc-200 text-xs">' +
                    '<div class="flex justify-between items-start gap-3">' +
                        '<div class="min-w-0">' +
                            '<div class="font-bold text-zinc-800 break-words">' + escapeHtml(o.product_name) + ' × ' + escapeHtml(o.quantity) + '</div>' +
                            '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(o.merchant_name || '') + ' · ' + escapeHtml(formatRelativeDate(o.created_at)) + '</div>' +
                        '</div>' +
                        '<div class="text-right shrink-0">' +
                            '<div class="font-extrabold text-zinc-900">' + formatNumber(o.paid_amount) + '원</div>' +
                            (o.points_used > 0 ? '<div class="text-[10px] text-zinc-400">포인트 ' + formatNumber(o.points_used) + 'P 사용</div>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="mt-2"><span class="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border ' + orderStatusClass(o.status) + '">' + orderStatusLabel(o.status) + '</span></div>' +
                '</div>'
            ).join('');
        }

        function isOverlayOpen() {
            const portal = document.getElementById('merchant-portal');
            const admin = document.getElementById('admin-fullscreen');
            return (!!portal && !portal.classList.contains('hidden')) || (!!admin && !admin.classList.contains('hidden'));
        }

        let overlayToastTimer = null;
        function showOverlayToast(message) {
            const el = document.getElementById('overlay-toast');
            if (!el) return;
            el.innerText = message;
            el.classList.remove('hidden');
            clearTimeout(overlayToastTimer);
            overlayToastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
        }

        function isMerchantPortalOpen() {
            const el = document.getElementById('merchant-portal');
            return !!el && !el.classList.contains('hidden');
        }

        function openMerchantPortal() {
            const mch = getCurrentMerchant();
            if (!mch || !state.merchantToken) {
                showToast('가맹점 로그인이 필요합니다.');
                return;
            }
            closeModal('modal-pos');
            document.getElementById('merchant-portal').classList.remove('hidden');
            document.getElementById('portal-merchant-name').innerText = mch.name;
            const select = document.getElementById('pf-category');
            if (select && !select.options.length) {
                select.innerHTML = SHOP_CATEGORIES.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
            }
            switchPortalSection('dashboard');
        }

        function closeMerchantPortal() {
            const el = document.getElementById('merchant-portal');
            if (el) el.classList.add('hidden');
            closePortalProductForm();
            if (getCurrentMerchant()) openMerchantDashboard();
        }

        function switchPortalSection(name) {
            state.portalSection = name;
            ['dashboard', 'products', 'orders'].forEach(sec => {
                const section = document.getElementById('portal-section-' + sec);
                if (section) section.classList.toggle('hidden', sec !== name);
                const nav = document.getElementById('portal-nav-' + sec);
                if (nav) nav.className = 'portal-nav w-full text-left px-3.5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 ' +
                    (sec === name ? 'bg-white text-zinc-900' : 'text-zinc-300 hover:bg-zinc-800');
            });

            if (name === 'dashboard') {
                renderPortalDashboard();
                loadMerchantProducts();
                loadMerchantOrders();
            } else if (name === 'products') {
                loadMerchantProducts();
            } else if (name === 'orders') {
                loadMerchantOrders();
            }
        }

        function renderPortalDashboard() {
            const mch = getCurrentMerchant();
            if (!mch) return;
            document.getElementById('portal-unsettled').innerText = formatNumber(mch.unsettledBalance) + '원';
            document.getElementById('portal-total-sales').innerText = formatNumber(mch.totalSales) + '원';
            document.getElementById('portal-settle-acc').innerText = mch.accountNo || '-';
            document.getElementById('portal-pending-orders').innerText = state.merchantOrders.filter(o => o.status === 'paid').length + '건';
            document.getElementById('portal-active-products').innerText = state.merchantProducts.filter(p => p.active && !p.hidden).length + '개';

            const list = document.getElementById('portal-sales-list');
            const sales = (mch.salesHistory || []).slice(0, 10);
            list.innerHTML = sales.length
                ? sales.map(item =>
                    '<div class="flex justify-between items-center text-xs bg-zinc-50 border border-zinc-100 rounded-xl px-3.5 py-2.5">' +
                        '<div class="min-w-0"><div class="font-semibold text-zinc-800 truncate">' + escapeHtml(item.title) + '</div>' +
                        '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(item.date || '') + (item.settled ? ' · 정산 완료' : ' · 미정산') + '</div></div>' +
                        '<div class="font-extrabold text-zinc-900 shrink-0 ml-3">+' + formatNumber(item.amount) + '원</div>' +
                    '</div>').join('')
                : '<div class="text-center py-6 text-xs text-zinc-400">매출 내역이 없습니다.</div>';
        }

        async function portalSettle() {
            await executeMerchantSettlement();
            const mch = getCurrentMerchant();
            if (mch) await refreshMerchantFromServer(mch.id);
            renderPortalDashboard();
        }

        async function loadMerchantProducts() {
            const { data, error } = await merchantRpc('app_merchant_list_products', {});
            if (error) {
                if (!isInvalidSessionError(error)) showToast('상품 목록을 불러오지 못했습니다.');
                return;
            }
            state.merchantProducts = Array.isArray(data) ? data : [];
            renderMerchantProducts();
            if (state.portalSection === 'dashboard') renderPortalDashboard();
        }

        function renderMerchantProducts() {
            const box = document.getElementById('portal-products-list');
            if (!box) return;

            if (!state.merchantProducts.length) {
                box.innerHTML = '<div class="text-center py-14 text-sm text-zinc-400">등록된 상품이 없습니다. 오른쪽 위 "상품 등록" 버튼으로 첫 상품을 추가해 보세요.</div>';
                return;
            }

            box.innerHTML =
                '<div class="hidden md:grid grid-cols-12 gap-3 px-5 py-3 bg-zinc-50 border-b border-zinc-100 text-[11px] font-semibold text-zinc-400">' +
                    '<div class="col-span-5">상품</div><div class="col-span-2">가격</div><div class="col-span-1">재고</div><div class="col-span-2">상태</div><div class="col-span-2 text-right">관리</div>' +
                '</div>' +
                state.merchantProducts.map(p => {
                    const img = safeImageSrc(p.image);
                    const stockText = p.stock === null || p.stock === undefined ? '무제한' : formatNumber(p.stock) + '개';
                    const status = p.hidden
                        ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">관리자 숨김</span>'
                        : (p.active
                            ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">판매 중</span>'
                            : '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500 border border-zinc-200">판매 중지</span>');
                    return '<div class="grid grid-cols-12 gap-3 items-center px-5 py-3.5 border-b border-zinc-100 last:border-b-0">' +
                        '<div class="col-span-12 md:col-span-5 flex items-center gap-3 min-w-0">' +
                            '<div class="w-12 h-12 rounded-lg bg-zinc-100 overflow-hidden shrink-0 flex items-center justify-center text-zinc-300">' +
                                (img ? '<img src="' + img + '" alt="" class="w-full h-full object-cover">' : '<i class="fa-regular fa-image"></i>') +
                            '</div>' +
                            '<div class="min-w-0"><div class="text-sm font-bold text-zinc-900 truncate">' + escapeHtml(p.name) + '</div>' +
                            '<div class="text-[11px] text-zinc-400">' + escapeHtml(p.category) + '</div></div>' +
                        '</div>' +
                        '<div class="col-span-4 md:col-span-2 text-sm font-semibold">' + formatNumber(p.price) + '원</div>' +
                        '<div class="col-span-3 md:col-span-1 text-xs text-zinc-500">' + stockText + '</div>' +
                        '<div class="col-span-5 md:col-span-2">' + status + '</div>' +
                        '<div class="col-span-12 md:col-span-2 flex md:justify-end gap-1.5">' +
                            '<button onclick="openPortalProductForm(' + jsArg(p.id) + ')" class="px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-xs font-semibold text-zinc-700">수정</button>' +
                            '<button onclick="togglePortalProductActive(' + jsArg(p.id) + ')" class="px-2.5 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-xs font-semibold text-zinc-700">' + (p.active ? '중지' : '판매') + '</button>' +
                            '<button onclick="deletePortalProduct(' + jsArg(p.id) + ')" class="px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-xs font-semibold text-red-600">삭제</button>' +
                        '</div>' +
                    '</div>';
                }).join('');
        }

        function openPortalProductForm(id) {
            const p = id ? state.merchantProducts.find(x => x.id === id) : null;
            document.getElementById('pf-title').innerText = p ? '상품 수정' : '상품 등록';
            document.getElementById('pf-id').value = p ? p.id : '';
            document.getElementById('pf-name').value = p ? p.name : '';
            document.getElementById('pf-price').value = p ? p.price : '';
            document.getElementById('pf-stock').value = p && p.stock !== null && p.stock !== undefined ? p.stock : '';
            document.getElementById('pf-desc').value = p && p.description ? p.description : '';
            document.getElementById('pf-active').checked = p ? !!p.active : true;
            const select = document.getElementById('pf-category');
            if (!select.options.length) {
                select.innerHTML = SHOP_CATEGORIES.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
            }
            select.value = p ? p.category : SHOP_CATEGORIES[0];
            state.portalImage = p && safeImageSrc(p.image) ? p.image : '';
            document.getElementById('pf-image-file').value = '';
            renderPortalImagePreview();
            const btn = document.getElementById('pf-save-btn');
            btn.disabled = false;
            btn.innerText = '저장';
            document.getElementById('portal-product-modal').classList.remove('hidden');
        }

        function closePortalProductForm() {
            const modal = document.getElementById('portal-product-modal');
            if (modal) modal.classList.add('hidden');
        }

        function renderPortalImagePreview() {
            const box = document.getElementById('pf-image-preview');
            if (!box) return;
            box.innerHTML = state.portalImage
                ? '<img src="' + state.portalImage + '" alt="" class="w-full h-full object-cover">'
                : '<i class="fa-regular fa-image"></i>';
        }

        function clearPortalProductImage() {
            state.portalImage = '';
            document.getElementById('pf-image-file').value = '';
            renderPortalImagePreview();
        }

        function compressImageFile(file, maxSide) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error('read_failed'));
                reader.onload = () => {
                    const img = new Image();
                    img.onerror = () => reject(new Error('bad_image'));
                    img.onload = () => {
                        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                        const w = Math.max(1, Math.round(img.width * scale));
                        const h = Math.max(1, Math.round(img.height * scale));
                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, w, h);
                        ctx.drawImage(img, 0, 0, w, h);
                        let quality = 0.78;
                        let out = canvas.toDataURL('image/jpeg', quality);
                        while (out.length > 150000 && quality > 0.3) {
                            quality -= 0.1;
                            out = canvas.toDataURL('image/jpeg', quality);
                        }
                        if (out.length > 190000) reject(new Error('too_large'));
                        else resolve(out);
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(file);
            });
        }

        async function onPortalImageSelected(input) {
            const file = input.files && input.files[0];
            if (!file) return;
            if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
                showToast('JPG, PNG, WEBP 이미지만 올릴 수 있습니다.');
                input.value = '';
                return;
            }
            try {
                state.portalImage = await compressImageFile(file, 480);
                renderPortalImagePreview();
            } catch (err) {
                console.error('이미지 처리 오류:', err);
                showToast('이미지를 처리하지 못했습니다. 다른 이미지를 선택해 주세요.');
                input.value = '';
            }
        }

        async function savePortalProduct() {
            const btn = document.getElementById('pf-save-btn');
            if (btn.disabled) return;

            const id = document.getElementById('pf-id').value;
            const name = document.getElementById('pf-name').value.trim();
            const priceRaw = document.getElementById('pf-price').value;
            const stockRaw = document.getElementById('pf-stock').value.trim();
            const price = parseInt(priceRaw, 10);

            if (!name) { showToast('상품명을 입력해 주세요.'); return; }
            if (!price || price < 100) { showToast('가격은 100원 이상으로 입력해 주세요.'); return; }
            if (stockRaw !== '' && (!/^\d+$/.test(stockRaw) || parseInt(stockRaw, 10) > 99999)) { showToast('재고는 0~99999 사이 숫자로 입력해 주세요.'); return; }

            btn.disabled = true;
            btn.innerText = '저장 중...';

            const { data, error } = await merchantRpc('app_merchant_save_product', {
                p_id: id || null,
                p_name: name,
                p_price: price,
                p_description: document.getElementById('pf-desc').value.trim() || null,
                p_image: state.portalImage || null,
                p_category: document.getElementById('pf-category').value,
                p_stock: stockRaw === '' ? null : parseInt(stockRaw, 10),
                p_active: document.getElementById('pf-active').checked
            });

            if (error || !data || !data.ok) {
                const msg = {
                    invalid_name: '상품명을 확인해 주세요.',
                    invalid_description: '상품 설명에 사용할 수 없는 문자가 있습니다.',
                    invalid_price: '가격은 100원 이상 1억 원 이하로 입력해 주세요.',
                    invalid_category: '카테고리를 선택해 주세요.',
                    invalid_stock: '재고 수량을 확인해 주세요.',
                    invalid_image: '이미지 형식이나 크기를 확인해 주세요.',
                    limit_reached: '상품은 최대 100개까지 등록할 수 있습니다.',
                    not_found: '상품을 찾을 수 없습니다.'
                }[data && data.reason] || '상품을 저장하지 못했습니다.';
                if (!error || !isInvalidSessionError(error)) showToast(msg);
                btn.disabled = false;
                btn.innerText = '저장';
                return;
            }

            closePortalProductForm();
            showToast(id ? '상품을 수정했습니다.' : '상품을 등록했습니다.');
            await loadMerchantProducts();
        }

        async function togglePortalProductActive(id) {
            const p = state.merchantProducts.find(x => x.id === id);
            if (!p) return;
            const { data, error } = await merchantRpc('app_merchant_set_product_active', { p_id: id, p_active: !p.active });
            if (error || !data || !data.ok) {
                if (!error || !isInvalidSessionError(error)) showToast('상태를 변경하지 못했습니다.');
                return;
            }
            showToast(p.active ? '판매를 중지했습니다.' : '판매를 다시 시작했습니다.');
            await loadMerchantProducts();
        }

        async function deletePortalProduct(id) {
            const p = state.merchantProducts.find(x => x.id === id);
            if (!p) return;
            if (!window.confirm('"' + p.name + '" 상품을 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;
            const { error } = await merchantRpc('app_merchant_delete_product', { p_id: id });
            if (error) {
                if (!isInvalidSessionError(error)) showToast('상품을 삭제하지 못했습니다.');
                return;
            }
            showToast('상품을 삭제했습니다.');
            await loadMerchantProducts();
        }

        async function loadMerchantOrders() {
            const { data, error } = await merchantRpc('app_merchant_list_orders', { p_limit: 100 });
            if (error) {
                if (!isInvalidSessionError(error)) showToast('주문 목록을 불러오지 못했습니다.');
                return;
            }
            state.merchantOrders = Array.isArray(data) ? data : [];
            renderMerchantOrders();
            if (state.portalSection === 'dashboard') renderPortalDashboard();
        }

        function renderMerchantOrders() {
            const box = document.getElementById('portal-orders-list');
            if (!box) return;

            if (!state.merchantOrders.length) {
                box.innerHTML = '<div class="text-center py-14 text-sm text-zinc-400">아직 들어온 주문이 없습니다.</div>';
                return;
            }

            box.innerHTML =
                '<div class="hidden md:grid grid-cols-12 gap-3 px-5 py-3 bg-zinc-50 border-b border-zinc-100 text-[11px] font-semibold text-zinc-400">' +
                    '<div class="col-span-3">상품</div><div class="col-span-2">구매자</div><div class="col-span-2">결제 금액</div><div class="col-span-2">상태</div><div class="col-span-3 text-right">처리</div>' +
                '</div>' +
                state.merchantOrders.map(o => {
                    const actions = o.status === 'paid'
                        ? '<button onclick="completePortalOrder(' + jsArg(o.id) + ')" class="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-xs font-semibold text-white">수령 완료</button>' +
                          '<button onclick="cancelPortalOrder(' + jsArg(o.id) + ')" class="px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-xs font-semibold text-red-600">취소·환불</button>'
                        : '<span class="text-[11px] text-zinc-300">-</span>';
                    return '<div class="grid grid-cols-12 gap-3 items-center px-5 py-3.5 border-b border-zinc-100 last:border-b-0 text-xs">' +
                        '<div class="col-span-12 md:col-span-3 min-w-0"><div class="text-sm font-bold text-zinc-900 truncate">' + escapeHtml(o.product_name) + ' × ' + escapeHtml(o.quantity) + '</div>' +
                            '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(formatRelativeDate(o.created_at)) + '</div></div>' +
                        '<div class="col-span-4 md:col-span-2 text-zinc-700 truncate">' + escapeHtml(o.buyer_alias) + '</div>' +
                        '<div class="col-span-4 md:col-span-2 font-semibold">' + formatNumber(o.paid_amount) + '원' +
                            (o.points_used > 0 ? '<div class="text-[10px] text-zinc-400 font-normal">포인트 ' + formatNumber(o.points_used) + 'P</div>' : '') + '</div>' +
                        '<div class="col-span-4 md:col-span-2"><span class="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border ' + orderStatusClass(o.status) + '">' + orderStatusLabel(o.status) + '</span></div>' +
                        '<div class="col-span-12 md:col-span-3 flex md:justify-end gap-1.5">' + actions + '</div>' +
                    '</div>';
                }).join('');
        }

        async function completePortalOrder(id) {
            const { data, error } = await merchantRpc('app_merchant_complete_order', { p_order_id: id });
            if (error || !data || !data.ok) {
                if (!error || !isInvalidSessionError(error)) showToast('수령 완료 처리를 하지 못했습니다.');
                return;
            }
            showToast('수령 완료로 처리했습니다.');
            await loadMerchantOrders();
        }

        async function cancelPortalOrder(id) {
            const order = state.merchantOrders.find(o => o.id === id);
            if (!order) return;
            if (!window.confirm('이 주문을 취소하고 ' + formatNumber(order.paid_amount) + '원을 구매자에게 환불할까요?')) return;
            const { data, error } = await merchantRpc('app_merchant_cancel_order', { p_order_id: id });
            if (error || !data || !data.ok) {
                const msg = {
                    already_settled: '이미 정산된 주문은 취소할 수 없습니다.',
                    invalid_status: '이미 처리된 주문입니다.',
                    not_found: '주문을 찾을 수 없습니다.'
                }[data && data.reason] || '주문을 취소하지 못했습니다.';
                if (!error || !isInvalidSessionError(error)) showToast(msg);
                return;
            }
            showToast('주문을 취소하고 환불했습니다.');
            await loadMerchantOrders();
            const mch = getCurrentMerchant();
            if (mch) await refreshMerchantFromServer(mch.id);
        }

        async function loadAdminProducts() {
            const box = document.getElementById('admin-products-list');
            if (!box) return;
            box.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';
            const { data, error } = await authRpc('app_admin_list_products', {});
            if (error) {
                box.innerHTML = '<div class="text-center py-4 text-xs text-red-500">상품 목록을 불러오지 못했습니다.</div>';
                return;
            }
            const rows = Array.isArray(data) ? data : [];
            if (!rows.length) {
                box.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">등록된 상품이 없습니다.</div>';
                return;
            }
            box.innerHTML = rows.map(p =>
                '<div class="flex items-center justify-between gap-3 bg-zinc-50 border border-zinc-100 rounded-xl px-3.5 py-2.5 text-xs">' +
                    '<div class="min-w-0"><div class="font-bold text-zinc-900 truncate">' + escapeHtml(p.name) + '</div>' +
                    '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(p.merchant_name) + ' · ' + formatNumber(p.price) + '원 · ' + escapeHtml(p.category) +
                    (p.active ? '' : ' · 판매 중지') + '</div></div>' +
                    '<button onclick="adminToggleProductHidden(' + jsArg(p.id) + ', ' + (p.hidden ? 'false' : 'true') + ')" class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold ' +
                        (p.hidden ? 'bg-zinc-900 text-white' : 'bg-red-50 text-red-600 hover:bg-red-100') + '">' + (p.hidden ? '숨김 해제' : '숨기기') + '</button>' +
                '</div>'
            ).join('');
        }

        async function adminToggleProductHidden(productId, hidden) {
            const adminPin = await promptAdminPin();
            if (!adminPin) return;
            const { error } = await adminRpc('set_product_hidden', {
                p_admin_pin: adminPin,
                p_product_id: productId,
                p_hidden: hidden
            });
            if (error) {
                showToast(adminRpcErrorMessage(error));
                return;
            }
            showToast(hidden ? '상품을 숨겼습니다.' : '상품 숨김을 해제했습니다.');
            loadAdminProducts();
        }

        function openTransferModal() {
            openModal('modal-transfer');
        }

        function addTransferAmount(val) {
            const input = document.getElementById('transfer-amount');
            if (input) {
                const cur = parseAmountInput(input.value);
                input.value = cur + val;
            }
        }

        async function findRecipientAccountLive(query) {
            try {
                const { data, error } = await authRpc('app_find_recipient', { p_query: String(query || '') });
                if (error || !data) {
                    if (error && !isInvalidSessionError(error)) console.error('수신자 조회 오류:', error);
                    return 'error';
                }
                if (data.status === 'ambiguous') return 'ambiguous';
                if (data.status === 'ok' && data.match) return data.match;
                return null;
            } catch (err) {
                console.error('수신자 조회 오류:', err);
                return 'error';
            }
        }

        const LARGE_TRANSFER_THRESHOLD = 500000;
        const PAYMENT_FEE_RATE = 0.07;
        const TRANSFER_RATE_WINDOW_MINUTES = 5;
        const TRANSFER_RATE_MAX_RECIPIENTS = 3;

        async function checkTransferRateLimit(accountId, newRecipientAlias) {
            const { data: recentNames, error } = await authRpc('app_recent_transfer_recipients', {
                p_account_id: accountId,
                p_minutes: TRANSFER_RATE_WINDOW_MINUTES
            });

            if (error) {
                console.error('이체 한도 체크 오류:', error);
                return { allowed: true };
            }

            const distinctRecipients = new Set((recentNames || []).filter(Boolean));

            if (distinctRecipients.has(newRecipientAlias)) {
                return { allowed: true };
            }
            if (distinctRecipients.size >= TRANSFER_RATE_MAX_RECIPIENTS) {
                return { allowed: false };
            }
            return { allowed: true };
        }

        async function openTransferConfirm() {
            const recipientInput = document.getElementById('transfer-recipient');
            const amountInput = document.getElementById('transfer-amount');
            const memoInput = document.getElementById('transfer-memo');

            const recipient = recipientInput ? recipientInput.value.trim() : '';
            const amount = amountInput ? parseAmountInput(amountInput.value) : 0;
            const memo = memoInput ? memoInput.value.trim() : '';

            if (!recipient) {
                showToast('받는 사람의 이름, 계좌번호, 디스코드 ID, UID 중 하나를 입력해 주세요.');
                return;
            }
            if (!amount || amount <= 0) {
                showToast('이체할 금액을 올바르게 입력해 주세요.');
                return;
            }

            const user = getCurrentUser();
            const activeAcc = getActiveAccount();

            if (!user || !activeAcc) return;

            let freshSenderAcc;
            try {
                const { data, error } = await authRpc('app_my_account_state', { p_account_id: activeAcc.id });
                if (error || !data || !data.ok) {
                    showToast('계좌 상태를 확인하는 중 오류가 발생했습니다.');
                    return;
                }
                freshSenderAcc = data;
            } catch (err) {
                console.error('보내는 계좌 상태 확인 오류:', err);
                showToast('계좌 상태를 확인하는 중 오류가 발생했습니다.');
                return;
            }

            activeAcc.isFrozen = freshSenderAcc.is_frozen || false;
            activeAcc.balance = freshSenderAcc.balance;

            if (activeAcc.isFrozen) {
                showToast('정지된 계좌입니다. 이체를 이용할 수 없습니다.');
                renderApp();
                return;
            }

            if (activeAcc.balance < amount) {
                showToast('계좌 잔액이 부족합니다.');
                return;
            }

            showToast('받는 분 계좌를 확인하는 중입니다...');
            const match = await findRecipientAccountLive(recipient);

            if (match === 'ambiguous') {
                showToast('일치하는 회원이 여러 명 있습니다. UID나 계좌번호로 입력해 주세요.');
                return;
            }
            if (match === 'error') {
                showToast('서버 조회 중 오류가 발생했습니다. 다시 시도해 주세요.');
                return;
            }
            if (!match) {
                showToast('받는 사람을 찾을 수 없습니다. 계좌번호, 이름, 디스코드 ID, UID 중 하나를 정확히 입력해 주세요.');
                return;
            }
            if (match.accountId === activeAcc.id) {
                showToast('본인의 같은 계좌로는 이체할 수 없습니다.');
                return;
            }
            if (match.isFrozen) {
                showToast('받는 분의 계좌가 정지되어 이체할 수 없습니다.');
                return;
            }

            const rateCheck = await checkTransferRateLimit(activeAcc.id, match.alias);
            if (!rateCheck.allowed) {
                showToast('짧은 시간에 너무 많은 사람에게 이체할 수 없습니다. (' + TRANSFER_RATE_WINDOW_MINUTES + '분 내 최대 ' + TRANSFER_RATE_MAX_RECIPIENTS + '명) 잠시 후 다시 시도해 주세요.');
                return;
            }

            state.pendingTransfer = { match, amount, memo, requestId: genRequestId() };

            document.getElementById('transfer-confirm-recipient-name').innerText = match.alias;
            document.getElementById('transfer-confirm-recipient-acc').innerText = match.accountNo ? maskAccountNo(match.accountNo) : '계좌번호 확인됨';
            document.getElementById('transfer-confirm-amount').innerText = formatNumber(amount) + '원';

            const memoWrap = document.getElementById('transfer-confirm-memo-wrap');
            if (memo) {
                document.getElementById('transfer-confirm-memo').innerText = memo;
                memoWrap.classList.remove('hidden');
            } else {
                memoWrap.classList.add('hidden');
            }

            closeModal('modal-transfer', true);
            openModal('modal-transfer-confirm');
        }

        async function confirmTransfer() {
            const pending = state.pendingTransfer;
            if (!pending) {
                closeModal('modal-transfer-confirm');
                return;
            }
            const { match, amount, memo } = pending;

            const user = getCurrentUser();
            const activeAcc = getActiveAccount();
            if (!user || !activeAcc) return;

            const confirmBtn = document.getElementById('transfer-confirm-btn');
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.innerText = '이체 처리 중...';
            }

            let result;
            try {
                const { data, error } = await authRpc('app_transfer', {
                    p_from_account: activeAcc.id,
                    p_to_account: match.accountId,
                    p_amount: amount,
                    p_memo: memo || null,
                    p_request_id: pending.requestId
                });
                if (error) {
                    console.error('이체 처리 오류:', error);
                    showToast('이체 처리 중 오류가 발생했습니다.');
                    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerText = '이체하기'; }
                    return;
                }
                result = data && data[0];
            } catch (err) {
                console.error('이체 처리 오류:', err);
                showToast('이체 처리 중 오류가 발생했습니다.');
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerText = '이체하기'; }
                return;
            }

            if (!result || !result.ok) {
                const reasonMsg = {
                    invalid_amount: '이체 금액이 올바르지 않습니다.',
                    same_account: '본인의 같은 계좌로는 이체할 수 없습니다.',
                    from_not_found: '보내는 계좌 정보를 확인할 수 없습니다.',
                    to_not_found: '받는 계좌 정보를 확인할 수 없습니다.',
                    from_frozen: '정지된 계좌입니다. 이체를 이용할 수 없습니다.',
                    to_frozen: '받는 분의 계좌가 정지되어 이체할 수 없습니다.',
                    insufficient_balance: '계좌 잔액이 부족합니다.',
                    rate_limited: '짧은 시간에 너무 많은 사람에게 이체할 수 없습니다. 잠시 후 다시 시도해 주세요.'
                }[result && result.reason] || '이체를 처리할 수 없습니다.';

                showToast(reasonMsg);
                if (result && result.from_balance !== null && result.from_balance !== undefined) {
                    activeAcc.balance = result.from_balance;
                }
                closeModal('modal-transfer-confirm');
                renderApp();
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerText = '이체하기'; }
                return;
            }

            activeAcc.balance = result.from_balance;
            if (!user.transactions.some(t => t.id === result.tx_id)) {
                user.transactions.unshift({
                    id: result.tx_id || genId('tx'),
                    accountId: activeAcc.id,
                    title: match.alias + ' 님에게 이체',
                    counterparty: match.alias,
                    memo: memo || '',
                    date: '방금 전',
                    createdAt: new Date().toISOString(),
                    amount: -amount,
                    type: 'transfer'
                });
            }

            state.pendingTransfer = null;
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.innerText = '이체하기';
            }

            closeModal('modal-transfer-confirm');
            user.sessionAccountId = null;
            renderApp();
            showToast(match.alias + ' 님에게 ' + formatNumber(amount) + '원을 이체하였습니다.');

            const recipientInput = document.getElementById('transfer-recipient');
            const amountInput = document.getElementById('transfer-amount');
            const memoInput = document.getElementById('transfer-memo');
            if (recipientInput) recipientInput.value = '';
            if (amountInput) amountInput.value = '';
            if (memoInput) memoInput.value = '';
        }

        const ACCOUNT_TYPE_OPTIONS = [
            { value: 'KDB페이 자유 입출금 통장', type: 'checking', desc: '자유롭게 넣고 빼는 기본 통장', icon: 'fa-wallet' },
            { value: 'KDB 비상금 통장', type: 'emergency', desc: '급할 때 쓰려고 모아두는 통장', icon: 'fa-life-ring' },
            { value: 'KDB 고금리 자유 적금', type: 'savings', desc: '이자를 받는 적금 통장', icon: 'fa-seedling' }
        ];

        function formatInterestPct(rate) {
            return String(Math.round(Number(rate) * 1000) / 10);
        }

        function accountTypeDesc(opt) {
            const user = getCurrentUser();
            if (opt.type === 'savings' && user && user.interest && user.interest.enabled) {
                return '매월 ' + formatInterestPct(user.interest.monthly_rate) + '% 이자 · 최대 ' + formatNumber(user.interest.balance_cap) + '원';
            }
            return opt.desc;
        }

        function computeExpectedInterest(user) {
            const result = {};
            const cfg = user && user.interest;
            if (!cfg || !cfg.enabled) return result;
            const rateMicro = Math.round(Number(cfg.monthly_rate) * 1000000);
            const cap = Number(cfg.balance_cap) || 0;
            const savings = (user.accounts || [])
                .filter(a => a.accountType === 'savings' && !a.isFrozen)
                .slice()
                .sort((a, b) => {
                    const ta = a.createdAt || '', tb = b.createdAt || '';
                    if (ta !== tb) return ta < tb ? -1 : 1;
                    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
                });
            let before = 0;
            savings.forEach(a => {
                const bal = Math.max(Number(a.balance) || 0, 0);
                const eligible = Math.max(0, Math.min(bal, cap - before));
                result[a.id] = Math.floor(eligible * rateMicro / 1000000);
                before += bal;
            });
            return result;
        }

        function renderAccountTypeDropdown() {
            const input = document.getElementById('new-account-type');
            const menu = document.getElementById('account-type-menu');
            if (!input || !menu) return;

            const selected = ACCOUNT_TYPE_OPTIONS.find(o => o.value === input.value) || ACCOUNT_TYPE_OPTIONS[0];
            input.value = selected.value;

            document.getElementById('account-type-label').innerText = selected.value;
            document.getElementById('account-type-desc').innerText = accountTypeDesc(selected);
            document.getElementById('account-type-icon').innerHTML = '<i class="fa-solid ' + selected.icon + '"></i>';

            menu.innerHTML = ACCOUNT_TYPE_OPTIONS.map((opt, idx) => {
                const isSelected = opt.value === selected.value;
                return '<button type="button" role="option" aria-selected="' + isSelected + '" onclick="selectAccountType(' + jsArg(opt.value) + ')" ' +
                    'class="w-full flex items-center justify-between gap-3 px-3.5 py-3 text-left hover:bg-zinc-50 transition-colors ' + (idx === 0 ? '' : 'border-t border-zinc-100') + '">' +
                    '<span class="flex items-center gap-3 min-w-0">' +
                        '<span class="w-9 h-9 rounded-full ' + (isSelected ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500') + ' flex items-center justify-center shrink-0 text-xs"><i class="fa-solid ' + opt.icon + '"></i></span>' +
                        '<span class="min-w-0">' +
                            '<span class="block text-xs font-bold text-zinc-900 truncate">' + escapeHtml(opt.value) + '</span>' +
                            '<span class="block text-[10px] text-zinc-400 mt-0.5 truncate">' + escapeHtml(accountTypeDesc(opt)) + '</span>' +
                        '</span>' +
                    '</span>' +
                    (isSelected ? '<i class="fa-solid fa-check text-zinc-900 text-xs shrink-0"></i>' : '') +
                '</button>';
            }).join('');
        }

        function setAccountTypeDropdownOpen(open) {
            const menu = document.getElementById('account-type-menu');
            const trigger = document.getElementById('account-type-trigger');
            const chevron = document.getElementById('account-type-chevron');
            if (!menu || !trigger) return;

            trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (chevron) chevron.classList.toggle('rotate-180', open);

            if (open) {
                menu.classList.remove('hidden');
                requestAnimationFrame(() => menu.classList.remove('opacity-0', '-translate-y-1'));
            } else {
                menu.classList.add('opacity-0', '-translate-y-1');
                setTimeout(() => {
                    if (trigger.getAttribute('aria-expanded') !== 'true') menu.classList.add('hidden');
                }, 150);
            }
        }

        function toggleAccountTypeDropdown() {
            const trigger = document.getElementById('account-type-trigger');
            if (!trigger) return;
            setAccountTypeDropdownOpen(trigger.getAttribute('aria-expanded') !== 'true');
        }

        function selectAccountType(value) {
            const input = document.getElementById('new-account-type');
            if (!input) return;
            input.value = value;
            renderAccountTypeDropdown();
            setAccountTypeDropdownOpen(false);
        }

        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('account-type-dropdown');
            const trigger = document.getElementById('account-type-trigger');
            if (!dropdown || !trigger || trigger.getAttribute('aria-expanded') !== 'true') return;
            if (!dropdown.contains(e.target)) setAccountTypeDropdownOpen(false);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') setAccountTypeDropdownOpen(false);
        });

        function openCreateAccountModal() {
            const input = document.getElementById('new-account-type');
            if (input) input.value = ACCOUNT_TYPE_OPTIONS[0].value;
            renderAccountTypeDropdown();
            setAccountTypeDropdownOpen(false);
            openModal('modal-create-account');
        }

        async function executeCreateAccount() {
            const typeElem = document.getElementById('new-account-type');
            const aliasElem = document.getElementById('new-account-alias');

            const type = typeElem ? typeElem.value : 'KDB페이 자유 입출금 통장';
            const typeOption = ACCOUNT_TYPE_OPTIONS.find(o => o.value === type) || ACCOUNT_TYPE_OPTIONS[0];
            const alias = aliasElem ? aliasElem.value.trim() : '';

            const user = getCurrentUser();
            if (!user) return;

            const createBtn = document.getElementById('create-account-submit-btn');
            if (createBtn) createBtn.disabled = true;

            let newAccId, newAccNo;
            try {
                const { data: accData, error: accErr } = await authRpc('app_create_account', {
                    p_name: alias || type,
                    p_type: typeOption.type
                });
                if (accErr || !accData || !accData[0]) {
                    console.error('계좌 생성 오류:', accErr);
                    showToast('계좌 생성 중 오류가 발생했습니다.');
                    if (createBtn) createBtn.disabled = false;
                    return;
                }
                newAccId = accData[0].id;
                newAccNo = accData[0].account_no;
            } catch (err) {
                console.error('계좌 생성 오류:', err);
                showToast('계좌 생성 중 오류가 발생했습니다.');
                if (createBtn) createBtn.disabled = false;
                return;
            }

            if (createBtn) createBtn.disabled = false;

            const newAccount = {
                id: newAccId,
                name: alias || type,
                accountNo: newAccNo,
                balance: 0,
                accountType: typeOption.type,
                createdAt: new Date().toISOString()
            };

            user.accounts.push(newAccount);
            setLocalAccountOrder(user.id, user.accounts.map(a => a.id));
            if (!user.currentAccountId) user.currentAccountId = newAccId;
            subscribeToRealtimeUpdates();

            saveAppData();
            closeModal('modal-create-account');
            renderApp();
            showToast('\'' + newAccount.name + '\' 계좌가 성공적으로 개설되었습니다.');

            if (aliasElem) aliasElem.value = '';
        }

        const ACCOUNT_ORDER_KEY_PREFIX = 'kdb_pay_account_order_v1_';

        function getLocalAccountOrder(userId) {
            try { return JSON.parse(localStorage.getItem(ACCOUNT_ORDER_KEY_PREFIX + userId)) || []; }
            catch (e) { return []; }
        }

        function setLocalAccountOrder(userId, ids) {
            try { localStorage.setItem(ACCOUNT_ORDER_KEY_PREFIX + userId, JSON.stringify(ids)); } catch (e) { }
        }

        function orderAccountRows(rows, localIds) {
            const localIdx = new Map((localIds || []).map((id, i) => [id, i]));
            const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
            const cmp = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

            return (rows || []).slice().sort((a, b) => {
                const sa = num(a.sort_order), sb = num(b.sort_order);
                if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
                if (sa !== null && sa !== sb) return cmp(sa, sb);

                const ia = localIdx.has(a.id) ? localIdx.get(a.id) : Infinity;
                const ib = localIdx.has(b.id) ? localIdx.get(b.id) : Infinity;
                if (ia !== ib) return ia < ib ? -1 : 1;

                const ca = a.created_at ? Date.parse(a.created_at) : 0;
                const cb = b.created_at ? Date.parse(b.created_at) : 0;
                if (ca !== cb) return cmp(ca, cb);

                return cmp(String(a.id), String(b.id));
            });
        }

        let _accountOrderTimer = null;
        function persistAccountOrder(user) {
            const ids = user.accounts.map(a => a.id);
            setLocalAccountOrder(user.id, ids);

            clearTimeout(_accountOrderTimer);
            _accountOrderTimer = setTimeout(async () => {
                try {
                    const { error } = await authRpc('app_set_account_order', {
                        p_account_ids: ids
                    });
                    if (error) {
                        const missing = error.code === 'PGRST202' || (error.message || '').includes('Could not find the function');
                        if (missing) console.info('set_account_order 함수가 없어 순서를 이 기기에만 저장했습니다.');
                        else console.warn('계좌 순서 서버 저장 오류:', error);
                    }
                } catch (err) {
                    console.warn('계좌 순서 서버 저장 오류:', err);
                }
            }, 500);
        }

        let accountReorderMode = false;

        function openAccountSelectorModal() {
            const user = getCurrentUser();
            if (!user) return;
            accountReorderMode = false;
            renderAccountSelectorList();
            openModal('modal-account-selector');
        }

        function toggleAccountReorderMode() {
            accountReorderMode = !accountReorderMode;
            renderAccountSelectorList();
        }

        function renderAccountSelectorList() {
            const user = getCurrentUser();
            const container = document.getElementById('account-selector-list');
            if (!user || !container) return;

            const accounts = user.accounts || [];
            const toggleBtn = document.getElementById('account-reorder-toggle');
            const hint = document.getElementById('account-reorder-hint');
            const title = document.getElementById('account-selector-title');

            if (accounts.length < 2) accountReorderMode = false;
            if (toggleBtn) {
                toggleBtn.classList.toggle('hidden', accounts.length < 2);
                toggleBtn.innerHTML = accountReorderMode
                    ? '<i class="fa-solid fa-check mr-1"></i>완료'
                    : '<i class="fa-solid fa-sort mr-1"></i>순서 변경';
            }
            if (hint) hint.classList.toggle('hidden', !accountReorderMode);
            if (title) title.innerText = accountReorderMode ? '계좌 순서 변경' : '내 계좌 관리';

            const primary = getPrimaryAccount();
            const primaryId = primary ? primary.id : null;
            const canDelete = accounts.length > 1;

            container.innerHTML = accounts.map((acc, idx) => {
                const isPrimary = acc.id === primaryId;
                const primaryBadge = isPrimary
                    ? '<span class="ml-1.5 text-[9px] font-bold text-white bg-zinc-900 px-1.5 py-0.5 rounded-full align-middle">주계좌</span>'
                    : '';
                const frozenBadge = acc.isFrozen
                    ? '<span class="ml-1.5 text-[9px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full align-middle">정지</span>'
                    : '';
                const info = '<div class="min-w-0 flex-1">' +
                        '<div class="font-bold text-xs text-zinc-900 truncate">' + escapeHtml(acc.name) + primaryBadge + frozenBadge + '</div>' +
                        '<div class="text-[11px] text-zinc-400 font-mono mt-0.5">' + escapeHtml(acc.accountNo) + '</div>' +
                    '</div>';
                const balance = '<div class="text-right shrink-0">' +
                        '<div class="font-extrabold text-sm text-zinc-900">' + formatNumber(acc.balance) + '원</div>' +
                    '</div>';

                if (accountReorderMode) {
                    const btnBase = 'w-9 h-8 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-600 flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
                    return '<div class="sel-acc-row p-3 rounded-2xl border border-zinc-200 flex items-center gap-3">' +
                        '<div class="acc-drag-handle shrink-0 -ml-1 w-9 h-11 flex items-center justify-center text-zinc-400 rounded-xl hover:bg-zinc-100" onpointerdown="startAccountDrag(event, this, \'account-selector-list\', \'.sel-acc-row\')" aria-label="끌어서 순서 변경"><i class="fa-solid fa-grip-lines text-base"></i></div>' +
                        info + balance +
                        '<div class="flex flex-col gap-1 shrink-0">' +
                            '<button type="button" onclick="moveAccount(' + jsArg(acc.id) + ', -1)" ' + (idx === 0 ? 'disabled' : '') + ' class="' + btnBase + '" aria-label="위로"><i class="fa-solid fa-chevron-up text-[11px]"></i></button>' +
                            '<button type="button" onclick="moveAccount(' + jsArg(acc.id) + ', 1)" ' + (idx === accounts.length - 1 ? 'disabled' : '') + ' class="' + btnBase + '" aria-label="아래로"><i class="fa-solid fa-chevron-down text-[11px]"></i></button>' +
                        '</div>' +
                    '</div>';
                }

                const btnCls = 'flex-1 text-[11px] font-bold py-2 rounded-lg transition-colors ';
                const primaryBtn = isPrimary
                    ? '<div class="' + btnCls + 'bg-zinc-900 text-white text-center"><i class="fa-solid fa-star mr-1"></i>주계좌</div>'
                    : '<button type="button" onclick="setPrimaryAccount(' + jsArg(acc.id) + ')" class="' + btnCls + 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700">주계좌로 설정</button>';
                const copyBtn = '<button type="button" onclick="copyAccountNo(' + jsArg(acc.id) + ')" class="' + btnCls + 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700"><i class="fa-regular fa-copy mr-1"></i>복사</button>';
                const delBtn = '<button type="button" onclick="openDeleteAccountModal(' + jsArg(acc.id) + ')" ' + (canDelete ? '' : 'disabled ') + 'class="' + btnCls + (canDelete ? 'bg-red-50 hover:bg-red-100 text-red-600' : 'bg-zinc-50 text-zinc-300 cursor-not-allowed') + '"><i class="fa-regular fa-trash-can mr-1"></i>삭제</button>';

                const borderClass = isPrimary ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 bg-white';
                return '<div class="p-4 rounded-2xl border ' + borderClass + '">' +
                    '<div class="flex justify-between items-center gap-3">' + info + balance + '</div>' +
                    '<div class="flex gap-2 mt-3">' + primaryBtn + copyBtn + delBtn + '</div>' +
                '</div>';
            }).join('');
        }

        function moveAccount(accId, direction) {
            const user = getCurrentUser();
            if (!user) return;
            const i = user.accounts.findIndex(a => a.id === accId);
            const j = i + direction;
            if (i < 0 || j < 0 || j >= user.accounts.length) return;

            const tmp = user.accounts[i];
            user.accounts[i] = user.accounts[j];
            user.accounts[j] = tmp;

            persistAccountOrder(user);
            renderAccountSelectorList();
            if (typeof renderHomeAccountList === 'function') renderHomeAccountList();
        }

        function setPrimaryAccount(accId) {
            const user = getCurrentUser();
            if (!user) return;
            const acc = user.accounts.find(a => a.id === accId);
            if (!acc) return;

            const wasPrimary = user.currentAccountId === accId;
            user.currentAccountId = accId;
            user.sessionAccountId = null;

            if (wasPrimary) {
                renderApp();
                renderAccountSelectorList();
                showToast('이미 주계좌로 설정되어 있습니다.');
                return;
            }

            saveAppData();
            renderApp();
            renderAccountSelectorList();
            showToast('\'' + acc.name + '\' 계좌가 주계좌로 설정되었습니다.');
        }

        function selectActiveAccount(accId) {
            setPrimaryAccount(accId);
        }

        function openDeleteAccountModal(accId) {
            const user = getCurrentUser();
            if (!user) return;
            const acc = user.accounts.find(a => a.id === accId);
            if (!acc) return;

            if (user.accounts.length <= 1) {
                showToast('마지막 남은 계좌는 삭제할 수 없습니다.');
                return;
            }
            if (acc.isFrozen) {
                showToast('정지된 계좌는 삭제할 수 없습니다.');
                return;
            }
            if (Number(acc.balance) !== 0) {
                showToast('잔액이 남아 있는 계좌는 삭제할 수 없습니다. 잔액을 다른 계좌로 이체해 주세요.');
                return;
            }

            state.pendingDeleteAccountId = accId;
            const primary = getPrimaryAccount();
            const nameEl = document.getElementById('delete-account-name');
            const noEl = document.getElementById('delete-account-no');
            const noteEl = document.getElementById('delete-account-primary-note');
            const confirmBtn = document.getElementById('delete-account-confirm-btn');
            if (nameEl) nameEl.innerText = acc.name;
            if (noEl) noEl.innerText = acc.accountNo;
            if (noteEl) noteEl.classList.toggle('hidden', !(primary && primary.id === accId));
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.innerText = '삭제하기';
            }
            openModal('modal-delete-account');
        }

        function cancelDeleteAccount() {
            state.pendingDeleteAccountId = null;
            closeModal('modal-delete-account');
        }

        let _deletingAccount = false;
        async function confirmDeleteAccount() {
            if (_deletingAccount) return;

            const user = getCurrentUser();
            const accId = state.pendingDeleteAccountId;
            if (!user || !accId) {
                cancelDeleteAccount();
                return;
            }

            const acc = user.accounts.find(a => a.id === accId);
            if (!acc || user.accounts.length <= 1 || acc.isFrozen || Number(acc.balance) !== 0) {
                cancelDeleteAccount();
                return;
            }

            _deletingAccount = true;
            const confirmBtn = document.getElementById('delete-account-confirm-btn');
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.innerText = '삭제 중...';
            }

            let failReason = null;
            try {
                const { data, error } = await authRpc('app_delete_account', { p_account_id: accId });
                if (error) {
                    console.error('계좌 삭제 오류:', error);
                    failReason = 'error';
                } else {
                    const row = Array.isArray(data) ? data[0] : data;
                    if (!row || row.ok === false) failReason = (row && row.reason) || 'error';
                }
            } catch (err) {
                console.error('계좌 삭제 오류:', err);
                failReason = 'error';
            }

            _deletingAccount = false;

            if (failReason) {
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.innerText = '삭제하기';
                }
                const msg = {
                    balance_remaining: '잔액이 남아 있는 계좌는 삭제할 수 없습니다.',
                    last_account: '마지막 남은 계좌는 삭제할 수 없습니다.',
                    frozen: '정지된 계좌는 삭제할 수 없습니다.',
                    not_found: '이미 삭제되었거나 존재하지 않는 계좌입니다.'
                }[failReason] || '계좌를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.';
                showToast(msg);
                return;
            }

            const primaryBefore = getPrimaryAccount();
            const wasPrimary = !!primaryBefore && primaryBefore.id === accId;
            const deletedName = acc.name;

            user.accounts = user.accounts.filter(a => a.id !== accId);
            user.transactions = (user.transactions || []).filter(t => t.accountId !== accId);
            if (wasPrimary && user.accounts[0]) user.currentAccountId = user.accounts[0].id;
            if (user.sessionAccountId === accId) user.sessionAccountId = null;

            persistAccountOrder(user);
            subscribeToRealtimeUpdates();
            saveAppData();

            state.pendingDeleteAccountId = null;
            closeModal('modal-delete-account');
            renderApp();
            renderAccountSelectorList();

            const newPrimary = getPrimaryAccount();
            showToast('\'' + deletedName + '\' 계좌를 삭제했습니다.' + (wasPrimary && newPrimary ? ' \'' + newPrimary.name + '\' 계좌가 주계좌로 변경되었습니다.' : ''));
        }

        function openProfileEditModal() {
            const user = getCurrentUser();
            if (!user) return;

            document.getElementById('edit-user-name').value = user.alias;
            document.getElementById('edit-user-discord').value = user.discord;
            const numIdInput = document.getElementById('edit-user-discord-numeric-id');
            if (numIdInput) numIdInput.value = user.discordNumericId || '';
            openModal('modal-profile');
        }

        function executeSaveProfile() {
            const user = getCurrentUser();
            if (!user) return;

            const newName = document.getElementById('edit-user-name').value.trim();
            const newDiscord = document.getElementById('edit-user-discord').value.trim();

            if (!newName) {
                showToast('이름을 입력해 주세요.');
                return;
            }

            user.alias = newName;
            if (newDiscord) user.discord = newDiscord;

            saveAppData();
            closeModal('modal-profile');
            renderApp();
            showToast('프로필 정보가 수정되었습니다.');
        }

        function attendanceDateKey(d) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return y + '-' + m + '-' + day;
        }

        let isClaimingAttendance = false;

        async function syncAttendanceFromServer(user) {
            try {
                const { data, error } = await authRpc('app_my_attendance');
                if (error || !data) return false;
                user.points = data.points || 0;
                user.attendanceHistory = data.attendance_history || {};
                return true;
            } catch (err) {
                console.error('출석 정보 동기화 오류:', err);
                return false;
            }
        }

        async function claimDailyAttendance() {
            const user = getCurrentUser();
            if (!user || isClaimingAttendance) return;
            isClaimingAttendance = true;

            const btnElem = document.getElementById('btn-attendance');
            if (btnElem) btnElem.disabled = true;

            const finish = () => {
                isClaimingAttendance = false;
                renderApp();
            };

            let result;
            try {
                const { data, error } = await authRpc('app_claim_attendance', {});
                if (error) {
                    console.error('출석체크 처리 오류:', error);
                    showToast('출석체크 처리 중 오류가 발생했습니다.');
                    finish();
                    return;
                }
                result = Array.isArray(data) ? data[0] : data;
            } catch (err) {
                console.error('출석체크 처리 오류:', err);
                showToast('출석체크 처리 중 오류가 발생했습니다.');
                finish();
                return;
            }

            const todayKey = attendanceDateKey(new Date());

            if (!result || !result.ok) {
                if (result && result.reason === 'already_claimed') {
                    await syncAttendanceFromServer(user);
                    if (!user.attendanceHistory) user.attendanceHistory = {};
                    if (!user.attendanceHistory[todayKey]) user.attendanceHistory[todayKey] = true;
                    showToast('오늘은 이미 출석체크를 완료하셨습니다.');
                } else {
                    showToast('출석체크를 처리할 수 없습니다.');
                }
                finish();
                return;
            }

            const earned = Number(result.earned_points) || 0;
            const beforePoints = user.points || 0;
            const synced = await syncAttendanceFromServer(user);
            if (!synced) {
                if (!user.attendanceHistory) user.attendanceHistory = {};
                user.points = beforePoints + earned;
            }
            if (!user.attendanceHistory[todayKey]) user.attendanceHistory[todayKey] = earned || true;

            showToast('출석체크 완료! ' + earned + 'P가 적립되었습니다!');
            finish();
        }

        function renderAttendanceWidget() {
            const user = getCurrentUser();
            const gridContainer = document.getElementById('attendance-days-grid');
            const btnElem = document.getElementById('btn-attendance');
            const btnTextElem = document.getElementById('attendance-btn-text');
            if (!gridContainer || !user) return;

            if (!user.attendanceHistory) {
                user.attendanceHistory = {};
            }

            const todayStr = attendanceDateKey(new Date());
            const isTodayClaimed = !!user.attendanceHistory[todayStr];

            if (btnElem && btnTextElem) {
                if (isTodayClaimed) {
                    btnElem.disabled = true;
                    btnElem.className = 'w-full bg-zinc-200 text-zinc-500 text-xs font-bold py-3.5 rounded-xl cursor-not-allowed flex items-center justify-center gap-2';
                    btnTextElem.innerText = '오늘 출석체크 완료됨 (내일 또 만나요)';
                } else {
                    btnElem.disabled = false;
                    btnElem.className = 'w-full bg-zinc-900 hover:bg-black text-white text-xs font-bold py-3.5 rounded-xl transition-all active:scale-95 shadow-md flex items-center justify-center gap-2';
                    btnTextElem.innerText = '오늘 출석체크 완료하기';
                }
            }

            const daysOfWeek = ['월', '화', '수', '목', '금', '토', '일'];
            const today = new Date();
            let html = '';

            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(today.getDate() - i);
                const dStr = attendanceDateKey(d);
                const dayLabel = daysOfWeek[(d.getDay() + 6) % 7];
                const claimed = user.attendanceHistory[dStr];
                const isCurrentToday = (i === 0);

                let bgClass = 'bg-zinc-100 text-zinc-400 border-zinc-200';
                let iconHtml = '<i class="fa-regular fa-circle text-xs"></i>';

                if (claimed) {
                    bgClass = 'bg-zinc-900 text-white border-zinc-900 shadow-sm';
                    iconHtml = '<i class="fa-solid fa-check text-xs"></i>';
                } else if (isCurrentToday) {
                    bgClass = 'bg-white text-zinc-900 border-2 border-zinc-900 font-bold shadow-sm';
                    iconHtml = '<span class="text-[10px]">오늘</span>';
                }

                html += '<div class="flex flex-col items-center justify-center p-2 rounded-xl border ' + bgClass + ' gap-1">' +
                    '<span class="text-[10px] font-semibold">' + dayLabel + '</span>' +
                    '<div class="w-7 h-7 rounded-lg flex items-center justify-center">' + iconHtml + '</div>' +
                '</div>';
            }
            gridContainer.innerHTML = html;
        }

        function switchMerchantAuthMode(mode) {
            state.merchantAuthMode = mode;

            const loginBtn = document.getElementById('mch-tab-login-btn');
            const signupBtn = document.getElementById('mch-tab-signup-btn');
            const loginView = document.getElementById('mch-login-view');
            const signupView = document.getElementById('mch-signup-view');

            if (mode === 'login') {
                loginBtn.className = 'flex-1 py-2 text-xs font-bold rounded-lg bg-white text-zinc-900 shadow-sm transition-all';
                signupBtn.className = 'flex-1 py-2 text-xs font-semibold rounded-lg text-zinc-500 transition-all';
                loginView.classList.remove('hidden');
                signupView.classList.add('hidden');
                loadMyMerchants();
            } else {
                signupBtn.className = 'flex-1 py-2 text-xs font-bold rounded-lg bg-white text-zinc-900 shadow-sm transition-all';
                loginBtn.className = 'flex-1 py-2 text-xs font-semibold rounded-lg text-zinc-500 transition-all';
                loginView.classList.add('hidden');
                signupView.classList.remove('hidden');
            }
        }

        function getCategoryIcon(category) {
            if (category === '카페/디저트') return 'fa-mug-hot';
            if (category === '음식점/식당') return 'fa-utensils';
            if (category === '편의점/마트') return 'fa-basket-shopping';
            if (category === '패션/뷰티') return 'fa-shirt';
            return 'fa-store';
        }

        function merchantRoleLabel(role) {
            return role === 'owner' ? '사장님(설립자)' : '권한 부여받은 직원';
        }

        async function loadMyMerchants() {
            if (!getCurrentUser() || !state.sessionToken) {
                state.myMerchants = [];
                renderMerchantLoginView();
                return;
            }
            const { data, error } = await authRpc('app_my_merchants', {});
            if (error) {
                if (!isInvalidSessionError(error)) {
                    console.error('내 가맹점 조회 오류:', error);
                    showToast('가맹점 목록을 불러오지 못했습니다.');
                }
                state.myMerchants = [];
            } else {
                state.myMerchants = Array.isArray(data) ? data : [];
            }
            renderMerchantLoginView();
        }

        function renderMerchantLoginView() {
            const labelElem = document.getElementById('mch-login-select-label');
            const dropdownElem = document.getElementById('mch-login-select-dropdown');
            const hiddenInput = document.getElementById('mch-login-select');
            const btnIcon = document.querySelector('#mch-login-select-btn i.fa-solid:not(.fa-chevron-down)');
            const nameElem = document.getElementById('mch-selected-name');
            const roleElem = document.getElementById('mch-selected-role');
            const hintElem = document.getElementById('mch-access-hint');
            const enterBtn = document.getElementById('mch-enter-btn');

            const loggedIn = !!getCurrentUser() && !!state.sessionToken;
            const list = state.myMerchants || [];

            if (dropdownElem) {
                dropdownElem.innerHTML = list.map(m =>
                    '<div onclick="selectLoginMerchant(' + jsArg(m.id) + ')" class="flex items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-zinc-50 cursor-pointer">' +
                        '<i class="fa-solid ' + getCategoryIcon(m.category) + ' text-zinc-500 w-3.5"></i> ' + escapeHtml(m.name) + ' (' + escapeHtml(m.category) + ')' +
                    '</div>'
                ).join('');
            }

            if (!loggedIn || list.length === 0) {
                state.selectedMerchantLoginId = null;
                if (hiddenInput) hiddenInput.value = '';
                if (labelElem) labelElem.innerText = loggedIn ? '접근 가능한 가맹점이 없습니다' : '로그인 후 이용할 수 있습니다';
                if (nameElem) nameElem.innerText = '-';
                if (roleElem) roleElem.innerText = '';
                if (hintElem) hintElem.innerText = loggedIn
                    ? '사장님이 권한을 부여하면 여기에 가맹점이 표시돼요. 직접 운영하려면 \'신규 가맹점 등록\'을 이용해 주세요.'
                    : '가맹점 대시보드는 개인 계정으로 로그인한 뒤 이용할 수 있어요.';
                if (enterBtn) enterBtn.disabled = true;
                return;
            }

            const current = list.find(m => m.id === state.selectedMerchantLoginId) || list[0];
            state.selectedMerchantLoginId = current.id;
            if (hiddenInput) hiddenInput.value = current.id;
            if (labelElem) labelElem.innerText = current.name + ' (' + current.category + ')';
            if (btnIcon) btnIcon.className = 'fa-solid ' + getCategoryIcon(current.category) + ' text-zinc-500 w-3.5';
            if (nameElem) nameElem.innerText = current.name;
            if (roleElem) roleElem.innerText = merchantRoleLabel(current.role);
            if (hintElem) hintElem.innerText = '가맹점을 설립한 사장님 또는 사장님이 권한을 부여한 직원만 접속할 수 있어요.';
            if (enterBtn) enterBtn.disabled = false;
        }

        function toggleMchLoginDropdown() {
            const dropdown = document.getElementById('mch-login-select-dropdown');
            if (dropdown) dropdown.classList.toggle('hidden');
        }

        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('mch-login-select-dropdown');
            const btn = document.getElementById('mch-login-select-btn');
            if (!dropdown || dropdown.classList.contains('hidden')) return;
            if (dropdown.contains(e.target) || (btn && btn.contains(e.target))) return;
            dropdown.classList.add('hidden');
        });

        function selectLoginMerchant(mchId) {
            state.selectedMerchantLoginId = mchId;
            renderMerchantLoginView();
            const dropdown = document.getElementById('mch-login-select-dropdown');
            if (dropdown) dropdown.classList.add('hidden');
        }

        async function enterMerchantDashboard() {
            const targetMchId = state.selectedMerchantLoginId;
            if (!targetMchId) return;
            if (!getCurrentUser() || !state.sessionToken) {
                showToast('먼저 개인 계정으로 로그인해 주세요.');
                return;
            }

            const enterBtn = document.getElementById('mch-enter-btn');
            if (enterBtn) enterBtn.disabled = true;

            let row;
            let loginToken = null;
            let role = null;
            try {
                const { data, error } = await authRpc('app_merchant_login', { p_merchant_id: targetMchId });
                if (error) {
                    if (String(error.message || '').includes('forbidden')) {
                        showToast('이 가맹점에 접근할 권한이 없습니다.');
                        loadMyMerchants();
                    } else if (!isInvalidSessionError(error)) {
                        console.error('가맹점 접속 오류:', error);
                        showToast('접속 확인 중 오류가 발생했습니다.');
                    }
                    if (enterBtn) enterBtn.disabled = false;
                    return;
                }
                row = data && data.ok ? data.merchant : null;
                loginToken = data && data.token ? data.token : null;
                role = data && data.role ? data.role : null;
            } catch (err) {
                console.error('가맹점 접속 오류:', err);
                showToast('접속 확인 중 오류가 발생했습니다.');
                if (enterBtn) enterBtn.disabled = false;
                return;
            }
            if (enterBtn) enterBtn.disabled = false;

            if (!row || !loginToken || !role) {
                showToast('이 가맹점에 접근할 권한이 없습니다.');
                return;
            }

            let localMch = state.merchants.find(m => m.id === row.id);
            if (!localMch) {
                localMch = { id: row.id, salesHistory: [] };
                state.merchants.push(localMch);
            }
            localMch.name = row.name;
            localMch.category = row.category;
            localMch.bizNo = row.biz_no;
            localMch.accountNo = row.account_no;
            localMch.unsettledBalance = row.unsettled_balance || 0;
            localMch.totalSales = row.total_sales || 0;
            localMch.status = row.status;

            if (localMch.status === 'pending') {
                showToast('관리자 승인 대기 중인 가맹점입니다. 승인 후 이용해 주세요.');
                return;
            }
            if (localMch.status === 'rejected') {
                showToast('승인이 거절된 가맹점입니다. 관리자에게 문의해 주세요.');
                return;
            }

            state.merchantToken = loginToken;
            await loadMerchantSales(localMch);

            state.currentMerchantId = localMch.id;
            state.currentMerchantRole = role;
            saveSession();
            showToast('\'' + localMch.name + '\' 가맹점으로 접속되었습니다.');
            renderMerchantDashboard();
        }

        async function executeMerchantSignup() {
            const nameInput = document.getElementById('mch-signup-name');
            const categorySelect = document.getElementById('mch-signup-category');
            const bizInput = document.getElementById('mch-signup-biz');
            const accInput = document.getElementById('mch-signup-acc');

            const name = nameInput ? nameInput.value.trim() : '';
            const category = categorySelect ? categorySelect.value : '기타 가맹점';
            const biz = bizInput ? bizInput.value.trim() : '';
            const acc = accInput ? accInput.value.trim() : '';

            if (!getCurrentUser() || !state.sessionToken) {
                showToast('가맹점 등록은 개인 계정으로 로그인한 뒤 가능합니다.');
                return;
            }

            if (!name || !biz || !acc) {
                showToast('모든 가맹점 정보를 올바르게 입력해 주세요.');
                return;
            }

            const mchSignupBtn = document.getElementById('mch-signup-submit-btn');
            if (mchSignupBtn) mchSignupBtn.disabled = true;

            let newMchId;
            try {
                const { data, error } = await authRpc('app_signup_merchant', {
                    p_name: name, p_category: category, p_biz_no: biz, p_account_no: acc
                });
                if (error) {
                    const msg = error.message || '';
                    if (msg.includes('biz_no_taken')) {
                        showToast('이미 등록된 사업자번호입니다.');
                    } else {
                        console.error('가맹점 가입 오류:', error);
                        showToast('가맹점 정보를 확인하는 중 오류가 발생했습니다. 다시 시도해 주세요.');
                    }
                    if (mchSignupBtn) mchSignupBtn.disabled = false;
                    return;
                }
                newMchId = data && data.merchant_id;
                if (!newMchId) throw new Error('merchant_signup_failed');
            } catch (err) {
                console.error('가맹점 가입 오류:', err);
                showToast('가맹점 정보를 확인하는 중 오류가 발생했습니다. 다시 시도해 주세요.');
                if (mchSignupBtn) mchSignupBtn.disabled = false;
                return;
            }

            if (mchSignupBtn) mchSignupBtn.disabled = false;

            const newMerchant = {
                id: newMchId,
                name: name,
                category: category,
                bizNo: biz,
                accountNo: acc,
                unsettledBalance: 0,
                totalSales: 0,
                salesHistory: [],
                status: 'pending'
            };

            if (nameInput) nameInput.value = '';
            if (bizInput) bizInput.value = '';
            if (accInput) accInput.value = '';

            showToast('가맹점 가입 신청이 완료되었습니다. 관리자 승인 후 목록에 표시되며 이용할 수 있습니다.');
            switchMerchantAuthMode('login');
        }

        function logoutMerchant() {
            const merchantTokenToRevoke = state.merchantToken;
            state.merchantToken = null;
            if (merchantTokenToRevoke) sbClient.rpc('app_logout', { p_token: merchantTokenToRevoke }).then(() => {}, () => {});
            state.currentMerchantId = null;
            state.currentMerchantRole = null;
            state.merchantMembers = [];
            const portalEl = document.getElementById('merchant-portal');
            if (portalEl) portalEl.classList.add('hidden');
            state.merchantProducts = [];
            state.merchantOrders = [];
            saveSession();
            cleanupMerchantWaiting();

            document.getElementById('merchant-auth-container').classList.remove('hidden');
            document.getElementById('merchant-dashboard-container').classList.add('hidden');

            const modalTitle = document.getElementById('merchant-modal-title');
            const modalSub = document.getElementById('merchant-modal-sub');
            if (modalTitle) modalTitle.innerText = '가맹점 POS 포털';
            if (modalSub) modalSub.innerText = '가맹점 인증 및 결제·정산 관리';

            switchMerchantAuthMode('login');
            showToast('가맹점에서 로그아웃 되었습니다.');
        }

        function openMerchantDashboard() {
            if (!getCurrentUser() || !state.sessionToken) {
                showToast('가맹점 대시보드는 로그인 후 이용할 수 있습니다.');
                return;
            }
            openModal('modal-pos');
            if (state.currentMerchantId) {
                renderMerchantDashboard();
            } else {
                document.getElementById('merchant-auth-container').classList.remove('hidden');
                document.getElementById('merchant-dashboard-container').classList.add('hidden');
                switchMerchantAuthMode('login');
            }
        }

        function renderMerchantDashboard() {
            const mch = getCurrentMerchant();
            if (!mch) return;

            document.getElementById('merchant-auth-container').classList.add('hidden');
            document.getElementById('merchant-dashboard-container').classList.remove('hidden');

            const modalTitle = document.getElementById('merchant-modal-title');
            const modalSub = document.getElementById('merchant-modal-sub');
            if (modalTitle) modalTitle.innerText = mch.name + ' POS';
            if (modalSub) modalSub.innerText = merchantRoleLabel(state.currentMerchantRole) + ' · 실시간 결제 승인 및 정산 센터';

            const dashName = document.getElementById('dash-mch-name');
            const dashBiz = document.getElementById('dash-mch-biz');
            if (dashName) dashName.innerText = mch.name;
            const membersBtn = document.getElementById('pos-subtab-members-btn');
            if (membersBtn) membersBtn.classList.toggle('hidden', state.currentMerchantRole !== 'owner');
            if (state.merchantTab === 'members' && state.currentMerchantRole !== 'owner') state.merchantTab = 'charge';
            if (dashBiz) dashBiz.innerText = mch.category + ' | 사업자 ' + mch.bizNo;

            const posCodeInput = document.getElementById('pos-input-code');
            if (posCodeInput) posCodeInput.value = '';

            const unsettledElem = document.getElementById('mch-unsettled-amount');
            const accNoElem = document.getElementById('mch-settlement-acc-no');
            const totalSalesElem = document.getElementById('mch-total-sales');
            const countElem = document.getElementById('mch-today-count');

            if (unsettledElem) unsettledElem.innerText = formatNumber(mch.unsettledBalance);
            if (accNoElem) accNoElem.innerText = mch.accountNo;
            if (totalSalesElem) totalSalesElem.innerText = formatNumber(mch.totalSales) + '원';
            if (countElem) countElem.innerText = mch.salesHistory.length + '건';

            const historyList = document.getElementById('mch-sales-history-list');
            if (historyList) {
                if (mch.salesHistory.length === 0) {
                    historyList.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">최근 거래 내역이 없습니다.</div>';
                } else {

                    historyList.innerHTML = mch.salesHistory.slice(0, 50).map(item => {
                        const netAmount = item.amount - (item.feeAmount || 0);
                        const feeHtml = item.feeAmount ? '<div class="text-[10px] text-zinc-400 mt-0.5">수수료 ' + formatNumber(item.feeAmount) + '원 차감 · 실수령 ' + formatNumber(netAmount) + '원</div>' : '';
                        return '<div class="bg-zinc-50 p-3 rounded-xl border border-zinc-200 flex justify-between items-center text-xs">' +
                            '<div>' +
                                '<div class="font-bold text-zinc-800">' + escapeHtml(item.title) + '</div>' +
                                '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(item.date) + '</div>' +
                                feeHtml +
                            '</div>' +
                            '<div class="text-right">' +
                                '<div class="font-bold text-zinc-900">' + formatNumber(item.amount) + '원</div>' +
                                '<span class="text-[10px] ' + (item.settled ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold') + '">' + (item.settled ? '정산완료' : '미정산') + '</span>' +
                            '</div>' +
                        '</div>';
                    }).join('');
                }
            }
        }

        function switchMerchantTab(tab) {
            if (tab === 'members' && state.currentMerchantRole !== 'owner') tab = 'charge';
            state.merchantTab = tab;
            const names = ['charge', 'settle', 'members'];
            names.forEach(n => {
                const btn = document.getElementById('pos-subtab-' + n + '-btn');
                const view = document.getElementById('pos-subview-' + n);
                if (btn) btn.className = (n === 'members' && state.currentMerchantRole !== 'owner' ? 'hidden ' : '') +
                    'flex-1 py-2 text-xs rounded-lg transition-all ' +
                    (n === tab ? 'font-bold bg-white text-zinc-900 shadow-sm' : 'font-semibold text-zinc-500');
                if (view) view.classList.toggle('hidden', n !== tab);
            });
            if (tab === 'members') loadMerchantMembers();
        }

        async function loadMerchantMembers() {
            const mch = getCurrentMerchant();
            if (!mch || state.currentMerchantRole !== 'owner') return;
            const { data, error } = await authRpc('app_merchant_list_members', { p_merchant_id: mch.id });
            if (error) {
                if (!isInvalidSessionError(error)) showToast('권한 보유자 목록을 불러오지 못했습니다.');
                return;
            }
            state.merchantMembers = Array.isArray(data) ? data : [];
            renderMerchantMembers();
        }

        function renderMerchantMembers() {
            const listEl = document.getElementById('mch-member-list');
            if (!listEl) return;
            const rows = state.merchantMembers || [];
            listEl.innerHTML = rows.length
                ? rows.map(m => {
                    const isOwner = m.role === 'owner';
                    return '<div class="flex items-center justify-between bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs">' +
                        '<div class="min-w-0"><div class="font-bold text-zinc-800 truncate">' + escapeHtml(m.alias || m.user_id) + '</div>' +
                        '<div class="text-[10px] text-zinc-400 font-mono truncate">' + escapeHtml(m.discord || m.user_id) + ' · ' + (isOwner ? '사장님' : '직원') + '</div></div>' +
                        (isOwner ? '<span class="text-[10px] font-bold text-zinc-400 shrink-0 ml-3">설립자</span>'
                                 : '<button onclick="removeMerchantMember(' + jsArg(m.user_id) + ')" class="shrink-0 ml-3 text-[11px] font-bold text-red-500 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 rounded-lg">권한 회수</button>') +
                    '</div>';
                }).join('')
                : '<div class="text-center py-6 text-xs text-zinc-400">권한을 부여받은 직원이 없습니다.</div>';
        }

        async function addMerchantMember() {
            const mch = getCurrentMerchant();
            const input = document.getElementById('mch-member-input');
            const btn = document.getElementById('mch-member-add-btn');
            const targetId = input ? input.value.trim() : '';
            if (!mch || state.currentMerchantRole !== 'owner') return;
            if (!targetId) { showToast('권한을 부여할 디스코드 ID를 입력해 주세요.'); return; }
            if (btn) btn.disabled = true;
            const { error } = await authRpc('app_merchant_add_member', { p_merchant_id: mch.id, p_member_discord: targetId });
            if (btn) btn.disabled = false;
            if (error) {
                const msg = String(error.message || '');
                if (msg.includes('user_not_found')) showToast('해당 디스코드 ID의 사용자를 찾을 수 없습니다.');
                else if (msg.includes('ambiguous_discord')) showToast('같은 디스코드 ID가 여러 명이에요. 관리자에게 문의해 주세요.');
                else if (msg.includes('already_member')) showToast('이미 권한이 부여된 사용자입니다.');
                else if (msg.includes('forbidden')) showToast('사장님만 권한을 부여할 수 있습니다.');
                else if (!isInvalidSessionError(error)) { console.error('권한 부여 오류:', error); showToast('권한 부여 중 오류가 발생했습니다.'); }
                return;
            }
            if (input) input.value = '';
            showToast('접근 권한을 부여했습니다.');
            loadMerchantMembers();
        }

        async function removeMerchantMember(userId) {
            const mch = getCurrentMerchant();
            if (!mch || state.currentMerchantRole !== 'owner') return;
            if (!window.confirm('이 사용자의 가맹점 접근 권한을 회수할까요?')) return;
            const { error } = await authRpc('app_merchant_remove_member', { p_merchant_id: mch.id, p_member_user_id: userId });
            if (error) {
                if (!isInvalidSessionError(error)) { console.error('권한 회수 오류:', error); showToast('권한 회수 중 오류가 발생했습니다.'); }
                return;
            }
            showToast('접근 권한을 회수했습니다.');
            loadMerchantMembers();
        }

        async function openPosConfirm() {
            const codeInput = document.getElementById('pos-input-code');
            const amtInput = document.getElementById('pos-input-amount');
            const code = codeInput ? codeInput.value.trim() : '';
            const amt = amtInput ? parseAmountInput(amtInput.value) : 0;

            if (!code || code.length !== 6) {
                showToast('6자리 결제 코드를 올바르게 입력해 주세요.');
                return;
            }
            if (!amt || amt <= 0) {
                showToast('결제 요청 금액을 입력해 주세요.');
                return;
            }
            if (amt < 5000) {
                showToast('최소 결제 요청 금액은 5,000원입니다.');
                return;
            }

            const mch = getCurrentMerchant();
            if (!mch) return;

            showToast('결제 코드를 확인하는 중입니다...');

            let lookup;
            try {
                const { data, error } = await merchantRpc('app_merchant_lookup_pay_code', { p_code: code });
                if (error) {
                    console.error('결제 코드 조회 오류:', error);
                    showToast('결제 코드 확인 중 오류가 발생했습니다.');
                    return;
                }
                lookup = data;
            } catch (err) {
                console.error('결제 코드 조회 오류:', err);
                showToast('결제 코드 확인 중 오류가 발생했습니다.');
                return;
            }

            if (!lookup || !lookup.ok) {
                showToast(lookup && lookup.reason === 'rate_limited'
                    ? '결제 코드 입력 실패가 너무 많습니다. 잠시 후 다시 시도해 주세요.'
                    : lookup && lookup.reason === 'frozen'
                        ? '고객의 계좌가 정지되어 결제할 수 없습니다.'
                        : '유효하지 않거나 만료된 결제 코드입니다. 고객에게 코드를 다시 확인해 주세요.');
                return;
            }

            const customerUser = { alias: lookup.customer_alias };
            const customerAcc = { account_no: lookup.account_no };

            state.pendingPosPayment = { codeRow: null, customerUser, customerAcc, amount: amt, code: code };

            document.getElementById('pos-confirm-customer-name').innerText = customerUser.alias;
            document.getElementById('pos-confirm-customer-acc').innerText = maskAccountNo(customerAcc.account_no);
            document.getElementById('pos-confirm-amount').innerText = formatNumber(amt) + '원';

            openModal('modal-pos-confirm');
        }

        async function executePosPayment() {
            const pending = state.pendingPosPayment;
            if (!pending) {
                closeModal('modal-pos-confirm');
                return;
            }
            const { codeRow, customerUser, customerAcc, amount: amt } = pending;

            const mch = getCurrentMerchant();
            if (!mch) return;

            const confirmBtn = document.getElementById('pos-confirm-btn');
            if (confirmBtn) {
                confirmBtn.disabled = true;
                confirmBtn.innerText = '요청 전송 중...';
            }

            let requestId;
            try {
                const { data: reqData, error: reqErr } = await merchantRpc('app_create_payment_request', {
                    p_code: pending.code,
                    p_amount: amt
                });
                if (reqErr || !reqData || !reqData.ok) {
                    const reason = reqData && reqData.reason;
                    showToast(reason === 'rate_limited'
                        ? '결제 코드 입력 실패가 너무 많습니다. 잠시 후 다시 시도해 주세요.'
                        : reason === 'invalid_code'
                        ? '유효하지 않거나 만료된 결제 코드입니다.'
                        : reason === 'frozen'
                            ? '고객의 계좌가 정지되어 결제할 수 없습니다.'
                            : '결제 요청을 보낼 수 없습니다.');
                    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerText = '결제 확정'; }
                    closeModal('modal-pos-confirm');
                    return;
                }
                requestId = reqData.request_id;
            } catch (err) {
                console.error('결제 요청 생성 오류:', err);
                showToast('결제 요청 전송 중 오류가 발생했습니다.');
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerText = '결제 확정'; }
                return;
            }

            state.pendingPosPayment = null;
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.innerText = '결제 확정';
            }

            closeModal('modal-pos-confirm');
            renderMerchantDashboard();
            showToast(customerUser.alias + ' 님에게 결제 요청을 보냈습니다. 승인을 기다리는 중입니다...');

            startWaitingForApproval({
                requestId: requestId,
                merchantId: mch.id,
                customerName: customerUser.alias,
                amount: amt,
                salesTitle: customerUser.alias + ' 님 현장 결제'
            });

            const codeInput = document.getElementById('pos-input-code');
            const amtInput = document.getElementById('pos-input-amount');
            if (codeInput) codeInput.value = '';
            if (amtInput) amtInput.value = '0';
        }

        let merchantWaitingTimer = null;

        function startWaitingForApproval(ctx) {
            cleanupMerchantWaiting();
            const startedAt = Date.now();
            let busy = false;

            const tick = async () => {
                if (busy || !merchantWaitingTimer) return;
                busy = true;
                try {
                    const { data, error } = await merchantRpc('app_merchant_payment_status', { p_request_id: ctx.requestId });
                    if (!merchantWaitingTimer) return;
                    const status = !error && data ? data.status : null;
                    if (status && status !== 'pending' && status !== 'not_found') {
                        handlePaymentRequestResult({ new: { status: status } }, ctx);
                    } else if (Date.now() - startedAt > 120000) {
                        cleanupMerchantWaiting();
                    }
                } finally {
                    busy = false;
                }
            };

            merchantWaitingTimer = setInterval(tick, 2000);
        }

        function cleanupMerchantWaiting() {
            if (merchantWaitingTimer) {
                clearInterval(merchantWaitingTimer);
                merchantWaitingTimer = null;
            }
        }

        function handlePaymentRequestResult(payload, ctx) {
            const row = payload.new;
            if (!row) return;

            if (row.status === 'approved') {
                cleanupMerchantWaiting();
                refreshMerchantFromServer(ctx.merchantId);
                showToast(ctx.customerName + '님이 ' + formatNumber(ctx.amount) + '원 결제 요청을 승인했습니다.');
            } else if (row.status === 'rejected') {
                cleanupMerchantWaiting();
                showToast(ctx.customerName + '님이 ' + formatNumber(ctx.amount) + '원 결제 요청을 거절했습니다.');
            } else if (row.status === 'expired') {
                cleanupMerchantWaiting();
                showToast(ctx.customerName + '님의 응답이 없어 결제 요청이 만료되었습니다.');
            }
        }

        async function executeMerchantSettlement() {
            const mch = getCurrentMerchant();
            if (!mch) return;

            if (mch.unsettledBalance <= 0) {
                showToast('정산할 미정산 매출 금액이 없습니다.');
                return;
            }

            const amt = mch.unsettledBalance;

            const settleBtn = document.getElementById('mch-settle-btn');
            const settleBtnOriginalHtml = settleBtn ? settleBtn.innerHTML : '';
            if (settleBtn) {
                settleBtn.disabled = true;
                settleBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 정산 처리 중...';
            }

            const restoreSettleBtn = () => {
                if (settleBtn) { settleBtn.disabled = false; settleBtn.innerHTML = settleBtnOriginalHtml; }
            };

            let settleResult;
            try {
                const { data, error } = await merchantRpc('app_settle_merchant', {});
                if (error) throw error;
                settleResult = data;
            } catch (err) {
                console.error('정산 처리 오류:', err);
                showToast('정산 처리 중 오류가 발생했습니다.');
                restoreSettleBtn();
                return;
            }

            if (!settleResult || !settleResult.ok) {
                const msg = {
                    nothing_to_settle: '정산할 미정산 매출 금액이 없습니다.',
                    account_not_found: '등록된 정산 계좌(' + mch.accountNo + ')를 찾을 수 없어 정산할 수 없습니다.',
                    frozen: '정산 계좌가 정지 상태라 정산할 수 없습니다. 관리자에게 문의해 주세요.'
                }[settleResult && settleResult.reason] || '정산 처리를 완료하지 못했습니다.';
                showToast(msg);
                restoreSettleBtn();
                return;
            }

            mch.unsettledBalance = 0;
            mch.salesHistory.forEach(s => s.settled = true);

            saveAppData();

            if (settleBtn) {
                settleBtn.disabled = false;
                settleBtn.innerHTML = settleBtnOriginalHtml;
            }

            renderMerchantDashboard();
            showToast(formatNumber(amt) + '원이 지정된 계좌(' + mch.accountNo + ')로 정산 입금되었습니다.');
        }

        let payCodeAutoRefreshTimer = null;
        let isGeneratingPayCode = false;

        async function generateNewCode(notify) {
            if (isGeneratingPayCode) return;
            isGeneratingPayCode = true;

            const icon = document.getElementById('refresh-icon');
            const refreshBtn = document.getElementById('refresh-code-btn');
            if (icon) icon.classList.add('rotating');
            if (refreshBtn) refreshBtn.disabled = true;

            const user = getCurrentUser();
            const activeAcc = getActiveAccount();
            if (!user || !activeAcc) {
                isGeneratingPayCode = false;
                if (icon) icon.classList.remove('rotating');
                if (refreshBtn) refreshBtn.disabled = false;
                return;
            }


            try {

                const { data: codeData, error: codeErr } = await authRpc('app_create_pay_code', { p_account_id: activeAcc.id });
                if (codeErr || !codeData || !codeData.ok) throw (codeErr || new Error('code_failed'));
                const newCode = codeData.code;

                state.currentPayCode = newCode;

                const display = document.getElementById('payment-code-display');
                if (display) {
                    display.innerText = newCode.slice(0, 3) + ' ' + newCode.slice(3);
                }
                if (notify === true) showToast('새로운 보안 결제 코드가 생성되었습니다.');
            } catch (err) {
                console.error('결제 코드 생성 오류:', err);
                showToast('결제 코드 생성 중 오류가 발생했습니다. 다시 시도해 주세요.');
            }

            if (icon) icon.classList.remove('rotating');
            if (refreshBtn) refreshBtn.disabled = false;
            isGeneratingPayCode = false;
        }

        function startPayCodeAutoRefresh() {
            stopPayCodeAutoRefresh();
            generateNewCode(false);
            payCodeAutoRefreshTimer = setInterval(() => generateNewCode(false), 30000);
        }

        function stopPayCodeAutoRefresh() {
            if (payCodeAutoRefreshTimer) {
                clearInterval(payCodeAutoRefreshTimer);
                payCodeAutoRefreshTimer = null;
            }
        }

        let _adminPinResolve = null;

        function promptAdminPin() {
            return new Promise((resolve) => {
                _adminPinResolve = resolve;
                const input = document.getElementById('admin-pin-input');
                if (input) input.value = '';
                const modal = document.getElementById('modal-admin-pin');
                if (modal) modal.classList.remove('hidden');
                setTimeout(() => { if (input) input.focus(); }, 150);
            });
        }

        function submitAdminPinPrompt() {
            const input = document.getElementById('admin-pin-input');
            const pin = input ? input.value.trim() : '';
            if (!pin || pin.length !== 4) {
                showToast('4자리 PIN을 입력해 주세요.');
                return;
            }
            const modal = document.getElementById('modal-admin-pin');
            if (modal) modal.classList.add('hidden');
            const resolve = _adminPinResolve;
            _adminPinResolve = null;
            if (resolve) resolve(pin);
        }

        function cancelAdminPinPrompt() {
            const modal = document.getElementById('modal-admin-pin');
            if (modal) modal.classList.add('hidden');
            const resolve = _adminPinResolve;
            _adminPinResolve = null;
            if (resolve) resolve(null);
        }

        let _userPinResolve = null;

        function promptUserPin() {
            return new Promise((resolve) => {
                _userPinResolve = resolve;
                const input = document.getElementById('user-pin-input');
                if (input) input.value = '';
                const modal = document.getElementById('modal-user-pin');
                if (modal) modal.classList.remove('hidden');
                setTimeout(() => { if (input) input.focus(); }, 150);
            });
        }

        function submitUserPinPrompt() {
            const input = document.getElementById('user-pin-input');
            const pin = input ? input.value.trim() : '';
            if (!pin || pin.length !== 4) {
                showToast('4자리 PIN을 입력해 주세요.');
                return;
            }
            const modal = document.getElementById('modal-user-pin');
            if (modal) modal.classList.add('hidden');
            const resolve = _userPinResolve;
            _userPinResolve = null;
            if (resolve) resolve(pin);
        }

        function cancelUserPinPrompt() {
            const modal = document.getElementById('modal-user-pin');
            if (modal) modal.classList.add('hidden');
            const resolve = _userPinResolve;
            _userPinResolve = null;
            if (resolve) resolve(null);
        }

        async function callBankBotTransfer(direction) {
            const user = getCurrentUser();
            const activeAcc = getDepositAccount();
            if (!user || !activeAcc) return;

            if (!user.discordNumericId) {
                showToast('먼저 마이페이지 → 프로필 수정에서 디스코드 숫자 ID를 등록해 주세요.');
                return;
            }

            const amtInput = document.getElementById('bot-transfer-amount');
            const memoInput = document.getElementById('bot-transfer-memo');
            const amount = amtInput ? parseAmountInput(amtInput.value) : 0;
            const memo = memoInput ? memoInput.value.trim() : '';

            if (!amount || amount <= 0) {
                showToast('금액을 올바르게 입력해 주세요.');
                return;
            }

            if (direction === 'withdrawal' && activeAcc.balance < amount) {
                showToast('계좌 잔액이 부족합니다.');
                return;
            }

            const pin = await promptUserPin();
            if (!pin) return;

            const btnId = direction === 'deposit' ? 'bot-deposit-btn' : 'bot-withdraw-btn';
            const btn = document.getElementById(btnId);
            const otherBtnId = direction === 'deposit' ? 'bot-withdraw-btn' : 'bot-deposit-btn';
            const otherBtn = document.getElementById(otherBtnId);
            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 처리 중...'; }
            if (otherBtn) otherBtn.disabled = true;

            try {
                const { data, error } = await sbClient.functions.invoke('bank-bot-transfer', {
                    body: {
                        user_id: user.id,
                        pin: pin,
                        token: state.sessionToken,
                        account_id: activeAcc.id,
                        direction: direction,
                        amount: amount,
                        memo: memo || (direction === 'deposit' ? '루루봇 충전' : '루루봇 출금')
                    }
                });

                if (error) {
                    console.error('봇 연동 오류:', error);
                    let serverMsg = '';
                    try {
                        const errBody = await error.context.json();
                        serverMsg = (errBody && errBody.error && errBody.error.message) || '';
                    } catch (e) {}
                    showToast(serverMsg || ('처리 중 오류가 발생했습니다: ' + (error.message || '')));
                    return;
                }

                if (!data || !data.ok) {
                    const msg = (data && data.error && data.error.message) || '루루봇 처리에 실패했습니다.';
                    showToast(msg);
                    return;
                }

                activeAcc.balance = data.new_balance;
                await loadUserFinancialData(user.id);
                renderApp();
                showToast(direction === 'deposit'
                    ? '루루봇에서 ' + depositAccountLabel(activeAcc) + ' 계좌로 잔액을 불러왔습니다.'
                    : depositAccountLabel(activeAcc) + ' 계좌에서 루루봇으로 출금했습니다.');
                closeModal('modal-deposit');

                if (amtInput) amtInput.value = '';
                if (memoInput) memoInput.value = '';
            } catch (err) {
                console.error('봇 연동 오류:', err);
                showToast('처리 중 오류가 발생했습니다.');
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
                if (otherBtn) otherBtn.disabled = false;
            }
        }

        async function adminRpc(name, args) {
            const res = await authRpc('app_admin_' + name, args);
            if (res.error) return res;
            const row = Array.isArray(res.data) ? res.data[0] : res.data;
            const hardReasons = ['invalid_credentials', 'not_admin', 'cannot_delete_self', 'account_not_found', 'user_not_found', 'locked'];
            if (row && row.ok === false && hardReasons.includes(row.reason)) {
                return { data: null, error: { message: row.reason, seconds_remaining: row.seconds_remaining } };
            }
            return res;
        }

        function adminRpcErrorMessage(error) {
            const msg = (error && error.message) || '';
            if (msg.includes('locked')) {
                const mins = Math.max(1, Math.ceil(((error && error.seconds_remaining) || 0) / 60));
                return 'PIN을 5회 틀려 관리자 기능이 잠겼습니다. ' + mins + '분 후 다시 시도해 주세요.';
            }
            if (msg.includes('not_admin')) return '관리자 권한이 없습니다.';
            if (msg.includes('invalid_credentials')) return 'PIN이 일치하지 않습니다.';
            if (msg.includes('cannot_delete_self')) return '본인 계정은 삭제할 수 없습니다.';
            if (msg.includes('account_not_found')) return '대상 계좌를 찾을 수 없습니다.';
            if (msg.includes('user_not_found')) return '대상 회원을 찾을 수 없습니다.';
            return '처리 중 오류가 발생했습니다.';
        }

        async function renderAdminAlerts() {
            const listEl = document.getElementById('admin-alert-list');
            const badge = document.getElementById('admin-alert-badge');
            if (!listEl) return;

            listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';

            try {
                const { data, error } = await authRpc('app_admin_alerts');

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
                    return;
                }

                if (!data || data.length === 0) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">고액 이체 알림이 없습니다.</div>';
                    if (badge) badge.classList.add('hidden');
                    return;
                }

                const unreadCount = data.filter(a => !a.read).length;
                if (badge) {
                    if (unreadCount > 0) {
                        badge.innerText = unreadCount > 99 ? '99+' : String(unreadCount);
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }

                listEl.innerHTML = data.map(a => {
                    const unreadDot = a.read ? '' : '<span class="w-2 h-2 bg-red-500 rounded-full inline-block mr-1.5 shrink-0"></span>';
                    return '<div class="border border-zinc-200 rounded-xl p-3 flex justify-between items-center gap-2">' +
                        '<div class="flex items-center min-w-0">' +
                            unreadDot +
                            '<div class="min-w-0">' +
                                '<div class="text-xs font-bold text-zinc-900 truncate">' + escapeHtml(a.message) + '</div>' +
                                '<div class="text-[10px] text-zinc-400 mt-0.5">' + formatRelativeDate(a.created_at) + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="text-sm font-extrabold text-amber-600 shrink-0">' + formatNumber(a.amount || 0) + '원</div>' +
                    '</div>';
                }).join('');

                await authRpc('app_admin_mark_alerts_read');
            } catch (err) {
                console.error('관리자 알림 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        async function renderAdminTopupRequests() {
            const listEl = document.getElementById('admin-topup-list');
            const badge = document.getElementById('admin-topup-badge');
            if (!listEl) return;

            listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';

            try {
                const { data: pending, error } = await authRpc('app_admin_pending_topups');

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
                    return;
                }

                if (!pending || pending.length === 0) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">대기 중인 충전 요청이 없습니다.</div>';
                    if (badge) badge.classList.add('hidden');
                    return;
                }

                if (badge) {
                    badge.innerText = pending.length > 99 ? '99+' : String(pending.length);
                    badge.classList.remove('hidden');
                }


                listEl.innerHTML = pending.map(r => {
                    const u = r.alias != null ? r : null;
                    const userLabel = u ? escapeHtml(u.alias) + ' (' + escapeHtml(u.discord) + ')' : escapeHtml(r.user_id);
                    return '<div class="border border-zinc-200 rounded-xl p-3">' +
                        '<div class="flex justify-between items-center mb-2">' +
                            '<div>' +
                                '<div class="text-xs font-bold text-zinc-900">' + userLabel + '</div>' +
                                (r.memo ? '<div class="text-[10px] text-zinc-500 mt-0.5">"' + escapeHtml(r.memo) + '"</div>' : '') +
                                '<div class="text-[10px] text-zinc-400 mt-0.5">' + formatRelativeDate(r.created_at) + '</div>' +
                            '</div>' +
                            '<div class="text-sm font-extrabold text-zinc-900 shrink-0">' + formatNumber(r.amount) + '원</div>' +
                        '</div>' +
                        '<div class="flex gap-1.5">' +
                            '<button onclick="adminReviewTopup(' + jsArg(r.id) + ', \'rejected\')" class="flex-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 py-1.5 rounded-lg text-xs font-bold">거절</button>' +
                            '<button onclick="adminReviewTopup(' + jsArg(r.id) + ', \'approved\')" class="flex-[2] bg-emerald-600 hover:bg-emerald-700 text-white py-1.5 rounded-lg text-xs font-bold">승인하고 충전</button>' +
                        '</div>' +
                    '</div>';
                }).join('');
            } catch (err) {
                console.error('충전 요청 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        async function adminReviewTopup(requestId, decision) {
            const admin = getCurrentUser();
            if (!admin || !admin.isAdmin) {
                showToast('관리자만 가능합니다.');
                return;
            }

            const adminPin = await promptAdminPin();
            if (!adminPin) return;

            try {
                const reqRow = { amount: 0 };

                const { data: rpcData, error: rpcErr } = await adminRpc('review_topup', {
                    p_admin_pin: adminPin,
                    p_request_id: requestId,
                    p_decision: decision
                });

                if (rpcErr) {
                    console.error('충전 요청 처리 오류:', rpcErr);
                    showToast(adminRpcErrorMessage(rpcErr));
                    renderAdminTopupRequests();
                    return;
                }

                const result = rpcData && rpcData[0];
                if (!result || !result.ok) {
                    const reasonMsg = {
                        already_processed: '이미 처리된 요청입니다.'
                    }[result && result.reason] || '요청을 처리할 수 없습니다.';
                    showToast(reasonMsg);
                    renderAdminTopupRequests();
                    return;
                }

                showToast(decision === 'approved' ? '충전을 승인했습니다.' : '충전 요청을 거절했습니다.');

                renderAdminTopupRequests();
                refreshServerStatus();
            } catch (err) {
                console.error('충전 요청 처리 오류:', err);
                showToast('처리 중 오류가 발생했습니다.');
            }
        }

        async function renderAdminPendingMerchants() {
            const listEl = document.getElementById('admin-merchant-pending-list');
            if (!listEl) return;

            listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';

            try {
                const { data: pending, error } = await authRpc('app_admin_pending_merchants');

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
                    return;
                }

                if (!pending || pending.length === 0) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">승인 대기 중인 가맹점이 없습니다.</div>';
                    return;
                }

                listEl.innerHTML = pending.map(m =>
                    '<div class="border border-zinc-200 rounded-xl p-3 flex justify-between items-center">' +
                        '<div>' +
                            '<div class="text-xs font-bold text-zinc-900">' + escapeHtml(m.name) + '</div>' +
                            '<div class="text-[10px] text-zinc-400">' + escapeHtml(m.category || '') + ' | 사업자번호 ' + escapeHtml(m.biz_no || '') + ' | 정산계좌 ' + escapeHtml(m.account_no || '') + '</div>' +
                        '</div>' +
                        '<div class="flex gap-1.5 shrink-0">' +
                            '<button onclick="adminReviewMerchant(' + jsArg(m.id) + ', \'approved\')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold">승인</button>' +
                            '<button onclick="adminReviewMerchant(' + jsArg(m.id) + ', \'rejected\')" class="bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold">거절</button>' +
                        '</div>' +
                    '</div>'
                ).join('');
            } catch (err) {
                console.error('가맹점 승인 목록 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        async function adminReviewMerchant(merchantId, decision, refreshDetail) {
            const admin = getCurrentUser();
            if (!admin || !admin.isAdmin) {
                showToast('관리자만 가능합니다.');
                return;
            }

            const adminPin = await promptAdminPin();
            if (!adminPin) return;

            let wasPending = false;
            try {
                const { data: curData } = await authRpc('app_admin_merchant_detail', { p_merchant_id: merchantId });
                const curRow = curData ? curData.merchant : null;
                wasPending = !!curRow && curRow.status === 'pending';
            } catch (err) {
                wasPending = false;
            }

            try {
                const { data: rpcData, error: rpcErr } = await adminRpc('review_merchant', {
                    p_admin_pin: adminPin,
                    p_merchant_id: merchantId,
                    p_decision: decision
                });

                if (rpcErr) {
                    console.error('가맹점 승인 처리 오류:', rpcErr);
                    showToast(adminRpcErrorMessage(rpcErr));
                    return;
                }

                const result = rpcData && rpcData[0];
                if (!result || !result.ok) {
                    showToast('가맹점 승인 상태를 변경할 수 없습니다.');
                    return;
                }

                const removed = decision === 'rejected' && wasPending;
                if (removed) {
                    state.merchants = state.merchants.filter(m => m.id !== merchantId);
                    closeAdminMerchantDetail();
                }

                showToast(decision === 'approved' ? '가맹점을 승인했습니다.' : (removed ? '가맹점 가입을 거절하고 목록에서 삭제했습니다.' : '가맹점 가입을 거절했습니다.'));
                renderAdminPendingMerchants();
                renderAdminMerchantList(document.getElementById('admin-merchant-search') ? document.getElementById('admin-merchant-search').value : '');
                if (refreshDetail && !removed) openAdminMerchantDetail(merchantId);
            } catch (err) {
                console.error('가맹점 승인 처리 오류:', err);
                showToast('처리 중 오류가 발생했습니다.');
            }
        }

        async function openAdminUserDetail(userId) {
            const modal = document.getElementById('admin-user-detail-modal');
            const body = document.getElementById('admin-user-detail-body');
            if (!modal || !body) return;

            body.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">불러오는 중...</div>';
            modal.classList.remove('hidden');

            try {
                const { data: detail, error: uErr } = await authRpc('app_admin_user_detail', { p_user_id: userId });
                if (uErr || !detail || !detail.ok) {
                    body.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">회원 정보를 불러오지 못했습니다.</div>';
                    return;
                }

                const user = detail.user;
                const accounts = orderAccountRows(detail.accounts || [], null);

                const { data: autoTransfers } = await authRpc('app_admin_user_auto_transfers', { p_user_id: userId });

                const transactions = detail.transactions || [];

                const accountsHtml = (accounts || []).map(acc => {
                    const frozenBadge = acc.is_frozen ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 ml-1.5">정지됨</span>' : '';
                    return '<div class="border border-zinc-200 rounded-xl p-3 mb-2">' +
                        '<div class="flex justify-between items-center">' +
                            '<div>' +
                                '<div class="text-xs font-bold text-zinc-900 flex items-center">' + escapeHtml(acc.name) + frozenBadge + '</div>' +
                                '<div class="text-[10px] text-zinc-400 font-mono mt-0.5">' + escapeHtml(acc.account_no) + '</div>' +
                            '</div>' +
                            '<div class="text-sm font-extrabold text-zinc-900">' + formatNumber(acc.balance) + '원</div>' +
                        '</div>' +
                        '<button onclick="adminToggleAccountFreeze(' + jsArg(acc.id) + ', ' + (!acc.is_frozen) + ', ' + jsArg(userId) + ')" class="w-full mt-2 ' + (acc.is_frozen ? 'bg-zinc-700 hover:bg-zinc-800' : 'bg-amber-500 hover:bg-amber-600') + ' text-white py-1.5 rounded-lg text-xs font-bold">' + (acc.is_frozen ? '계좌 정지 해제' : '계좌 정지') + '</button>' +
                    '</div>';
                }).join('') || '<div class="text-xs text-zinc-400 mb-2">보유 계좌가 없습니다.</div>';

                const txHtml = transactions.length ? transactions.map(t => {
                    const isPositive = t.amount > 0;
                    const amtClass = isPositive ? 'text-emerald-600' : 'text-zinc-900';
                    const sign = isPositive ? '+' : '';
                    return '<div class="flex justify-between items-center py-2 border-b border-zinc-100 last:border-0">' +
                        '<div>' +
                            '<div class="text-xs font-bold text-zinc-800">' + escapeHtml(t.title) + '</div>' +
                            '<div class="text-[10px] text-zinc-400">' + formatRelativeDate(t.created_at) + '</div>' +
                        '</div>' +
                        '<div class="text-xs font-bold ' + amtClass + '">' + sign + formatNumber(t.amount) + '원</div>' +
                    '</div>';
                }).join('') : '<div class="text-xs text-zinc-400 py-3 text-center">거래내역이 없습니다.</div>';

                const adminBadge = user.is_admin ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 ml-1.5">관리자</span>' : '';

                const autoTransferHtml = (autoTransfers && autoTransfers.length) ? autoTransfers.map(row => {
                    const paused = !row.active;
                    const failNote = (row.fail_count || 0) > 0 && row.last_result && row.last_result !== '성공'
                        ? '<div class="text-[10px] text-red-500 mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>최근 실패: ' + escapeHtml(row.last_result) + '</div>'
                        : '';
                    return '<div class="border border-zinc-200 rounded-xl p-3 mb-2">' +
                        '<div class="flex justify-between items-start">' +
                            '<div class="min-w-0">' +
                                '<div class="flex items-center gap-1.5 flex-wrap">' +
                                    '<span class="text-xs font-bold text-zinc-900 truncate">→ ' + escapeHtml(row.to_alias || '') + '</span>' +
                                    '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full ' + (paused ? 'bg-zinc-100 text-zinc-500' : 'bg-emerald-50 text-emerald-700') + '">' +
                                        (paused ? '일시정지' : '진행중') +
                                    '</span>' +
                                '</div>' +
                                '<div class="text-[10px] text-zinc-400 font-mono mt-0.5">' + escapeHtml(row.to_account_no || '') + '</div>' +
                                (row.memo ? '<div class="text-[10px] text-zinc-500 mt-1 italic">"' + escapeHtml(row.memo) + '"</div>' : '') +
                                failNote +
                            '</div>' +
                            '<div class="text-right shrink-0">' +
                                '<div class="text-sm font-extrabold text-zinc-900">' + formatNumber(row.amount) + '<span class="text-[10px] font-bold ml-0.5">원</span></div>' +
                                '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(atCycleLabel(row)) + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="text-[10px] text-zinc-500 mt-2 pt-2 border-t border-zinc-100">다음 이체일 <span class="font-bold text-zinc-700">' + escapeHtml(atPrettyDate(row.next_run_date)) + '</span></div>' +
                    '</div>';
                }).join('') : '<div class="text-xs text-zinc-400 mb-2">등록된 자동이체가 없습니다.</div>';

                body.innerHTML =
                    '<div class="flex items-center gap-3 mb-4">' +
                        '<div class="w-12 h-12 bg-zinc-900 rounded-full flex items-center justify-center text-white font-bold text-lg">' + escapeHtml(user.alias.charAt(0)) + '</div>' +
                        '<div>' +
                            '<div class="font-bold text-sm text-zinc-900 flex items-center">' + escapeHtml(user.alias) + adminBadge + '</div>' +
                            '<div class="text-xs text-zinc-400">' + escapeHtml(user.discord) + ' | UID ' + escapeHtml(user.uid) + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="grid grid-cols-2 gap-2 mb-4">' +
                        '<div class="bg-zinc-50 rounded-xl p-3 text-center border border-zinc-100">' +
                            '<div class="text-[10px] text-zinc-400 mb-1">포인트</div>' +
                            '<div class="text-sm font-extrabold text-zinc-900">' + formatNumber(user.points || 0) + 'P</div>' +
                        '</div>' +
                        '<div class="bg-zinc-50 rounded-xl p-3 text-center border border-zinc-100">' +
                            '<div class="text-[10px] text-zinc-400 mb-1">보유 계좌 수</div>' +
                            '<div class="text-sm font-extrabold text-zinc-900">' + (accounts ? accounts.length : 0) + '개</div>' +
                        '</div>' +
                    '</div>' +
                    '<h4 class="font-bold text-xs text-zinc-800 mb-2">계좌 목록</h4>' +
                    accountsHtml +
                    '<h4 class="font-bold text-xs text-zinc-800 mb-2 mt-4">자동이체 설정</h4>' +
                    autoTransferHtml +
                    '<h4 class="font-bold text-xs text-zinc-800 mb-2 mt-4">최근 거래내역 (최대 30건)</h4>' +
                    '<div class="border border-zinc-200 rounded-xl p-3">' + txHtml + '</div>';
            } catch (err) {
                console.error('고객 상세 조회 오류:', err);
                body.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        function closeAdminUserDetail() {
            const modal = document.getElementById('admin-user-detail-modal');
            if (modal) modal.classList.add('hidden');
        }

        async function openAdminMerchantDetail(merchantId) {
            const modal = document.getElementById('admin-merchant-detail-modal');
            const body = document.getElementById('admin-merchant-detail-body');
            if (!modal || !body) return;

            body.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">불러오는 중...</div>';
            modal.classList.remove('hidden');

            try {
                const { data: mDetail, error: mErr } = await authRpc('app_admin_merchant_detail', { p_merchant_id: merchantId });
                const mch = mDetail ? mDetail.merchant : null;
                if (mErr || !mch) {
                    body.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">가맹점 정보를 불러오지 못했습니다.</div>';
                    return;
                }

                const sales = (mDetail && mDetail.sales) || [];

                const statusLabel = mch.status === 'pending' ? '승인대기' : (mch.status === 'rejected' ? '거절됨' : '승인됨');
                const statusClass = mch.status === 'pending' ? 'bg-amber-100 text-amber-700' : (mch.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700');

                const salesHtml = sales.length ? sales.map(s => {
                    const feeAmount = s.fee_amount || 0;
                    const netAmount = s.amount - feeAmount;
                    const feeNote = feeAmount ? '<div class="text-[10px] text-zinc-400 mt-0.5">수수료 ' + formatNumber(feeAmount) + '원 차감 · 실수령 ' + formatNumber(netAmount) + '원</div>' : '';
                    const settledBadge = '<span class="text-[10px] ' + (s.settled ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold') + '">' + (s.settled ? '정산완료' : '미정산') + '</span>';
                    return '<div class="flex justify-between items-center py-2 border-b border-zinc-100 last:border-0">' +
                        '<div>' +
                            '<div class="text-xs font-bold text-zinc-800">' + escapeHtml(s.title || '') + '</div>' +
                            '<div class="text-[10px] text-zinc-400">' + formatRelativeDate(s.created_at) + '</div>' +
                            feeNote +
                        '</div>' +
                        '<div class="text-right">' +
                            '<div class="text-xs font-bold text-zinc-900">' + formatNumber(s.amount) + '원</div>' +
                            settledBadge +
                        '</div>' +
                    '</div>';
                }).join('') : '<div class="text-xs text-zinc-400 py-3 text-center">매출/정산 내역이 없습니다.</div>';

                const actionButtonsHtml =
                    '<div class="flex gap-1.5 mt-3">' +
                        '<button onclick="adminReviewMerchant(' + jsArg(mch.id) + ', \'rejected\', true)" class="flex-1 bg-red-500 hover:bg-red-600 text-white py-2 rounded-lg text-xs font-bold">거절 처리</button>' +
                        '<button onclick="adminReviewMerchant(' + jsArg(mch.id) + ', \'approved\', true)" class="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded-lg text-xs font-bold">승인 처리</button>' +
                    '</div>';

                body.innerHTML =
                    '<div class="flex items-center gap-3 mb-4">' +
                        '<div class="w-12 h-12 bg-zinc-900 rounded-full flex items-center justify-center text-white font-bold text-lg">' +
                            '<i class="fa-solid ' + getCategoryIcon(mch.category) + '"></i>' +
                        '</div>' +
                        '<div>' +
                            '<div class="font-bold text-sm text-zinc-900 flex items-center gap-1.5">' + escapeHtml(mch.name) +
                                '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full ' + statusClass + '">' + statusLabel + '</span>' +
                            '</div>' +
                            '<div class="text-xs text-zinc-400">' + escapeHtml(mch.category || '') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="grid grid-cols-2 gap-2 mb-4">' +
                        '<div class="bg-zinc-50 rounded-xl p-3 border border-zinc-100">' +
                            '<div class="text-[10px] text-zinc-400 mb-1">사업자번호</div>' +
                            '<div class="text-xs font-bold text-zinc-900 font-mono">' + escapeHtml(mch.biz_no || '-') + '</div>' +
                        '</div>' +
                        '<div class="bg-zinc-50 rounded-xl p-3 border border-zinc-100">' +
                            '<div class="text-[10px] text-zinc-400 mb-1">정산 계좌</div>' +
                            '<div class="text-xs font-bold text-zinc-900 font-mono">' + escapeHtml(mch.account_no || '-') + '</div>' +
                        '</div>' +
                        '<div class="bg-zinc-50 rounded-xl p-3 border border-zinc-100">' +
                            '<div class="text-[10px] text-zinc-400 mb-1">총 누적 매출</div>' +
                            '<div class="text-sm font-extrabold text-zinc-900">' + formatNumber(mch.total_sales || 0) + '원</div>' +
                        '</div>' +
                        '<div class="bg-zinc-50 rounded-xl p-3 border border-zinc-100">' +
                            '<div class="text-[10px] text-zinc-400 mb-1">미정산 금액</div>' +
                            '<div class="text-sm font-extrabold text-amber-600">' + formatNumber(mch.unsettled_balance || 0) + '원</div>' +
                        '</div>' +
                    '</div>' +
                    actionButtonsHtml +
                    '<h4 class="font-bold text-xs text-zinc-800 mb-2 mt-4">최근 매출 및 정산 내역 (최대 30건)</h4>' +
                    '<div class="border border-zinc-200 rounded-xl p-3">' + salesHtml + '</div>';
            } catch (err) {
                console.error('가맹점 상세 조회 오류:', err);
                body.innerHTML = '<div class="text-center py-6 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        function closeAdminMerchantDetail() {
            const modal = document.getElementById('admin-merchant-detail-modal');
            if (modal) modal.classList.add('hidden');
        }

        function pgQuoteFilterValue(value) {
            return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        }

        async function renderAdminUserList(search) {
            const listEl = document.getElementById('admin-user-list');
            if (!listEl) return;

            listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';

            try {
                const { data: listData, error } = await authRpc('app_admin_users', { p_search: search || '' });
                const users = listData ? listData.users : null;

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
                    return;
                }

                if (!users || users.length === 0) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">일치하는 회원이 없습니다.</div>';
                    return;
                }

                const accounts = orderAccountRows(listData.accounts || [], null);

                listEl.innerHTML = users.map(u => {
                    const acc = (accounts || []).find(a => a.id === u.current_account_id) || (accounts || []).find(a => a.user_id === u.id);
                    const balanceText = acc ? formatNumber(acc.balance) + '원' : '계좌 없음';
                    const frozenBadge = acc && acc.is_frozen ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 ml-1.5">계좌정지</span>' : '';
                    return '<div class="border border-zinc-200 rounded-xl p-3">' +
                        '<div class="flex justify-between items-center mb-2">' +
                            '<div class="cursor-pointer" onclick="openAdminUserDetail(' + jsArg(u.id) + ')">' +
                                '<div class="text-xs font-bold text-zinc-900 flex items-center hover:underline">' + escapeHtml(u.alias) + frozenBadge + '</div>' +
                                '<div class="text-[10px] text-zinc-400">' + escapeHtml(u.discord) + ' | UID ' + escapeHtml(u.uid) + '</div>' +
                            '</div>' +
                            '<div class="text-xs font-bold text-zinc-700">' + balanceText + '</div>' +
                        '</div>' +
                        (acc ? (
                            '<div class="flex gap-1.5 mb-1.5">' +
                                '<input type="number" id="admin-amt-' + u.id + '" placeholder="금액" step="1000" class="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg p-2 text-xs focus:outline-none">' +
                                '<button onclick="adminAdjustBalance(' + jsArg(u.id) + ', ' + jsArg(acc.id) + ', 1)" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 rounded-lg text-xs font-bold">지급</button>' +
                                '<button onclick="adminAdjustBalance(' + jsArg(u.id) + ', ' + jsArg(acc.id) + ', -1)" class="bg-red-500 hover:bg-red-600 text-white px-3 rounded-lg text-xs font-bold">차감</button>' +
                            '</div>'
                        ) : '') +
                        '<div class="flex gap-1.5 mb-1.5">' +
                            '<button onclick="openAdminUserDetail(' + jsArg(u.id) + ')" class="flex-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 py-1.5 rounded-lg text-xs font-bold">상세보기</button>' +
                        '</div>' +
                        '<div class="flex gap-1.5">' +
                            (acc ?
                                '<button onclick="adminToggleAccountFreeze(' + jsArg(acc.id) + ', ' + (!acc.is_frozen) + ')" class="flex-1 ' + (acc.is_frozen ? 'bg-zinc-700 hover:bg-zinc-800' : 'bg-amber-500 hover:bg-amber-600') + ' text-white py-1.5 rounded-lg text-xs font-bold">' + (acc.is_frozen ? '계좌 정지 해제' : '계좌 정지') + '</button>'
                                : '<button disabled class="flex-1 bg-zinc-200 text-zinc-400 py-1.5 rounded-lg text-xs font-bold cursor-not-allowed">계좌 없음</button>') +
                            '<button onclick="adminDeleteUser(' + jsArg(u.id) + ', ' + jsArg(u.alias) + ')" class="flex-1 bg-zinc-900 hover:bg-black text-white py-1.5 rounded-lg text-xs font-bold">계정 강제 삭제</button>' +
                        '</div>' +
                    '</div>';
                }).join('');
            } catch (err) {
                console.error('관리자 회원 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        async function adminToggleAccountFreeze(accountId, newFrozenState, refreshUserId) {
            const admin = getCurrentUser();
            if (!admin || !admin.isAdmin) {
                showToast('관리자만 가능합니다.');
                return;
            }

            const adminPin = await promptAdminPin();
            if (!adminPin) return;

            try {
                const { error } = await adminRpc('set_account_frozen', {
                    p_admin_pin: adminPin,
                    p_account_id: accountId,
                    p_frozen: newFrozenState
                });

                if (error) {
                    console.error('계좌 정지 처리 오류:', error);
                    showToast(adminRpcErrorMessage(error));
                    return;
                }

                showToast(newFrozenState ? '계좌를 정지했습니다.' : '계좌 정지를 해제했습니다.');
                const searchInput = document.getElementById('admin-user-search');
                renderAdminUserList(searchInput ? searchInput.value : '');
                if (refreshUserId) openAdminUserDetail(refreshUserId);
            } catch (err) {
                console.error('계좌 정지 처리 오류:', err);
                showToast('처리 중 오류가 발생했습니다.');
            }
        }

        async function adminDeleteUser(userId, alias) {
            const confirmed = window.confirm('정말로 \'' + alias + '\' 계정을 완전히 삭제하시겠습니까?\n계좌, 거래내역, 알림 등 관련 데이터가 모두 함께 삭제되며 되돌릴 수 없습니다.');
            if (!confirmed) return;

            const admin = getCurrentUser();
            if (!admin || !admin.isAdmin) {
                showToast('관리자만 가능합니다.');
                return;
            }

            const adminPin = await promptAdminPin();
            if (!adminPin) return;

            try {
                const { error } = await adminRpc('delete_user', {
                    p_admin_pin: adminPin,
                    p_target_user_id: userId
                });
                if (error) {
                    console.error('계정 삭제 오류:', error);
                    showToast(adminRpcErrorMessage(error));
                    return;
                }
                showToast('\'' + alias + '\' 계정이 삭제되었습니다.');
                const searchInput = document.getElementById('admin-user-search');
                renderAdminUserList(searchInput ? searchInput.value : '');
                refreshServerStatus();
            } catch (err) {
                console.error('계정 삭제 오류:', err);
                showToast('계정 삭제 중 오류가 발생했습니다.');
            }
        }

        async function adminAdjustBalance(userId, accountId, sign) {
            const input = document.getElementById('admin-amt-' + userId);
            const amt = input ? parseAmountInput(input.value) : 0;

            if (!amt || amt <= 0) {
                showToast('조정할 금액을 입력해 주세요.');
                return;
            }

            const admin = getCurrentUser();
            if (!admin || !admin.isAdmin) {
                showToast('관리자만 가능합니다.');
                return;
            }

            const adminPin = await promptAdminPin();
            if (!adminPin) return;

            let adjustResult;
            try {
                const { data: rpcData, error: rpcErr } = await adminRpc('adjust_balance', {
                    p_admin_pin: adminPin,
                    p_account_id: accountId,
                    p_delta: sign * amt
                });
                if (rpcErr) {
                    console.error('잔액 조정 오류:', rpcErr);
                    showToast(adminRpcErrorMessage(rpcErr));
                    return;
                }
                adjustResult = rpcData && rpcData[0];
            } catch (err) {
                console.error('잔액 조정 오류:', err);
                showToast('잔액 조정 중 오류가 발생했습니다.');
                return;
            }

            if (!adjustResult || !adjustResult.ok) {
                const reasonMsg = {
                    not_found: '계좌를 찾을 수 없습니다.',
                    insufficient_balance: '차감 후 잔액이 0원 미만이 될 수 없습니다.'
                }[adjustResult && adjustResult.reason] || '잔액을 조정할 수 없습니다.';
                showToast(reasonMsg);
                return;
            }

            const delta = sign * amt;

            try {
                showToast(formatNumber(amt) + '원이 ' + (sign > 0 ? '지급' : '차감') + '되었습니다.');
                const searchInput = document.getElementById('admin-user-search');
                renderAdminUserList(searchInput ? searchInput.value : '');
            } catch (err) {
                console.error('관리자 잔액 조정 오류:', err);
                showToast('잔액 조정 중 오류가 발생했습니다.');
            }
        }

        async function renderAdminMerchantList(search) {
            const listEl = document.getElementById('admin-merchant-list');
            if (!listEl) return;

            listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';

            try {
                const { data: merchants, error } = await authRpc('app_admin_merchants', { p_search: search || '' });

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
                    return;
                }

                if (!merchants || merchants.length === 0) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">등록된 가맹점이 없습니다.</div>';
                    return;
                }

                listEl.innerHTML = merchants.map(m => {
                    const statusLabel = m.status === 'pending' ? '승인대기' : (m.status === 'rejected' ? '거절됨' : '승인됨');
                    const statusClass = m.status === 'pending' ? 'bg-amber-100 text-amber-700' : (m.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700');
                    return '<div class="border border-zinc-200 rounded-xl p-3">' +
                        '<div class="flex justify-between items-center mb-2">' +
                            '<div class="cursor-pointer" onclick="openAdminMerchantDetail(' + jsArg(m.id) + ')">' +
                                '<div class="flex items-center gap-1.5">' +
                                    '<div class="text-xs font-bold text-zinc-900 hover:underline">' + escapeHtml(m.name) + '</div>' +
                                    '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full ' + statusClass + '">' + statusLabel + '</span>' +
                                '</div>' +
                                '<div class="text-[10px] text-zinc-400">' + escapeHtml(m.category || '') + ' | 사업자번호 ' + escapeHtml(m.biz_no || '') + '</div>' +
                            '</div>' +
                            '<div class="text-right text-[10px] text-zinc-500">' +
                                '<div>누적매출 ' + formatNumber(m.total_sales || 0) + '원</div>' +
                                '<div>미정산 ' + formatNumber(m.unsettled_balance || 0) + '원</div>' +
                            '</div>' +
                        '</div>' +
                        '<button onclick="openAdminMerchantDetail(' + jsArg(m.id) + ')" class="w-full bg-zinc-100 hover:bg-zinc-200 text-zinc-700 py-1.5 rounded-lg text-xs font-bold">상세보기</button>' +
                    '</div>';
                }).join('');
            } catch (err) {
                console.error('관리자 가맹점 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        async function renderAdminTransactionSearch(search) {
            const listEl = document.getElementById('admin-tx-list');
            if (!listEl) return;

            listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">불러오는 중...</div>';

            try {
                const { data: txs, error } = await authRpc('app_admin_transactions', { p_search: search || '' });

                if (error) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
                    return;
                }

                if (!txs || txs.length === 0) {
                    listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">일치하는 거래내역이 없습니다.</div>';
                    return;
                }

                listEl.innerHTML = txs.map(t => {
                    const isPositive = t.amount > 0;
                    const amtClass = isPositive ? 'text-emerald-600' : 'text-zinc-900';
                    const sign = isPositive ? '+' : '';
                    return '<div class="border border-zinc-200 rounded-xl p-3 flex justify-between items-center">' +
                        '<div>' +
                            '<div class="text-xs font-bold text-zinc-900">' + escapeHtml(t.title) + '</div>' +
                            '<div class="text-[10px] text-zinc-400">' + formatRelativeDate(t.created_at) + '</div>' +
                        '</div>' +
                        '<div class="text-xs font-bold ' + amtClass + '">' + sign + formatNumber(t.amount) + '원</div>' +
                    '</div>';
                }).join('');
            } catch (err) {
                console.error('관리자 거래내역 조회 오류:', err);
                listEl.innerHTML = '<div class="text-center py-4 text-xs text-zinc-400">조회 중 오류가 발생했습니다.</div>';
            }
        }

        async function refreshServerStatus() {
            const dot = document.getElementById('server-status-dot');
            const text = document.getElementById('server-status-text');
            const latencyEl = document.getElementById('server-status-latency');
            const updatedEl = document.getElementById('server-status-updated');

            if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
            if (text) text.innerText = '확인 중...';
            if (latencyEl) latencyEl.innerText = '';

            const startTime = performance.now();

            try {
                const { data: stats, error: uErr } = await authRpc('app_admin_stats');
                const userCount = stats ? stats.user_count : null;
                const merchantCount = stats ? stats.merchant_count : null;
                const merchantPendingCount = stats ? stats.merchant_pending_count : null;
                const txCount = stats ? stats.tx_count : null;
                const pendingPaymentCount = stats ? stats.pending_payment_count : null;
                const mErr = null, mpErr = null, tErr = null, ppErr = null;
                const feeErr = uErr;
                const totalFees = stats ? Number(stats.fee_total || 0) : 0;
                document.getElementById('stat-fee-total').innerText = feeErr ? '-' : formatNumber(totalFees) + '원';
                if (feeErr) console.error('수수료 합계 조회 오류:', feeErr);

                const latency = Math.round(performance.now() - startTime);

                if (uErr) {
                    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
                    if (text) text.innerText = '서버 연결 오류';
                    if (latencyEl) latencyEl.innerText = uErr.message || '';
                    console.error('서버 상태 조회 오류:', uErr);
                } else {
                    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
                    if (text) text.innerText = '정상 연결됨';
                    if (latencyEl) latencyEl.innerText = latency + 'ms';
                }
                if (mErr) console.error('가맹점 통계 조회 오류:', mErr);
                if (mpErr) console.error('가맹점 승인대기 통계 조회 오류:', mpErr);
                if (tErr) console.error('거래 통계 조회 오류:', tErr);
                if (ppErr) console.error('결제요청 통계 조회 오류:', ppErr);

                document.getElementById('stat-user-count').innerText = userCount != null ? userCount : '-';
                document.getElementById('stat-merchant-count').innerText = merchantCount != null ? merchantCount : '-';
                document.getElementById('stat-merchant-pending-count').innerText = merchantPendingCount != null ? merchantPendingCount : '-';
                document.getElementById('stat-tx-count').innerText = txCount != null ? txCount : '-';
                document.getElementById('stat-pending-payment-count').innerText = pendingPaymentCount != null ? pendingPaymentCount : '-';
            } catch (err) {
                console.error('서버 상태 조회 오류:', err);
                if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
                if (text) text.innerText = '서버 연결 오류';
            }

            if (updatedEl) {
                const now = new Date();
                const pad = n => n.toString().padStart(2, '0');
                updatedEl.innerText = '마지막 갱신: ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
            }
        }

        function openAdminPage() {
            const user = getCurrentUser();
            if (!user || !user.isAdmin) {
                showToast('관리자만 접근할 수 있습니다.');
                return;
            }
            document.getElementById('admin-fullscreen').classList.remove('hidden');
            refreshServerStatus();
            renderAdminAlerts();
            renderAdminTopupRequests();
            renderAdminPendingMerchants();
            renderAdminUserList('');
            renderAdminMerchantList('');
            renderAdminTransactionSearch('');
            loadAdminProducts();
        }

        function closeAdminPage() {
            document.getElementById('admin-fullscreen').classList.add('hidden');
        }

        function switchTab(tabId, el) {
            if (tabId !== 'home' && homeAccountEditMode) {
                homeAccountEditMode = false;
                renderHomeAccountList();
            }
            const tabs = document.querySelectorAll('.tab-content');
            tabs.forEach(t => t.classList.remove('active'));

            const targetTab = document.getElementById('tab-' + tabId);
            if (targetTab) targetTab.classList.add('active');

            const navItems = document.querySelectorAll('.nav-item');
            navItems.forEach(item => item.classList.remove('active'));

            if (el) {
                el.classList.add('active');
            }

            if (tabId === 'pay') {
                startPayCodeAutoRefresh();
            } else {
                stopPayCodeAutoRefresh();
            }

            if (tabId === 'shop') loadShopProducts(false);
        }

        const AUTO_TRANSFER_MAX_CATCHUP = 6;
        const AT_WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

        state.autoTransfers = [];
        state.autoTransferCycle = 'weekly';

        function atFormatDate(d) {
            return d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
        }

        function atParseDate(str) {
            const parts = String(str).split('-').map(Number);
            return new Date(parts[0], parts[1] - 1, parts[2]);
        }

        function atToday() {
            return atFormatDate(new Date());
        }

        function atPrettyDate(str) {
            const d = atParseDate(str);
            return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + AT_WEEKDAY_LABELS[d.getDay()] + ')';
        }

        function atAddWeeks(dateStr, n) {
            const d = atParseDate(dateStr);
            d.setDate(d.getDate() + 7 * n);
            return atFormatDate(d);
        }

        function atAddMonths(dateStr, anchorDay) {
            const d = atParseDate(dateStr);
            const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
            const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
            next.setDate(Math.min(anchorDay, lastDay));
            return atFormatDate(next);
        }

        function atNextRunDate(row) {
            if (row.cycle === 'weekly') return atAddWeeks(row.next_run_date, 1);
            return atAddMonths(row.next_run_date, row.day_of_month || atParseDate(row.next_run_date).getDate());
        }

        function atFirstRunWeekly(dow) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let diff = (dow - today.getDay() + 7) % 7;
            if (diff === 0) diff = 7;
            const d = new Date(today);
            d.setDate(d.getDate() + diff);
            return atFormatDate(d);
        }

        function atFirstRunMonthly(day) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
            const target = Math.min(day, lastDay);
            if (target > today.getDate()) {
                return atFormatDate(new Date(today.getFullYear(), today.getMonth(), target));
            }
            return atAddMonths(atFormatDate(new Date(today.getFullYear(), today.getMonth(), target)), day);
        }

        function atCycleLabel(row) {
            if (row.cycle === 'weekly') return '매주 ' + AT_WEEKDAY_LABELS[row.day_of_week] + '요일';
            return '매월 ' + row.day_of_month + '일';
        }

        async function loadAutoTransfers() {
            const user = getCurrentUser();
            if (!user) return;
            try {
                const { data, error } = await authRpc('app_list_auto_transfers', {});
                if (error) {
                    console.error('자동이체 조회 오류:', error);
                    return;
                }
                state.autoTransfers = Array.isArray(data) ? data : [];
                renderAutoTransferBadge();
            } catch (err) {
                console.error('자동이체 조회 오류:', err);
            }
        }

        function renderAutoTransferBadge() {
            const badge = document.getElementById('auto-transfer-count-badge');
            if (!badge) return;
            const activeCount = state.autoTransfers.filter(r => r.active).length;
            if (activeCount > 0) {
                badge.innerText = String(activeCount);
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        async function openAutoTransferModal() {
            const listEl = document.getElementById('auto-transfer-list');
            if (listEl) listEl.innerHTML = '<div class="text-center py-8 text-xs text-zinc-400">불러오는 중...</div>';
            openModal('modal-auto-transfer');
            await loadAutoTransfers();
            renderAutoTransferList();
        }

        function renderAutoTransferList() {
            const listEl = document.getElementById('auto-transfer-list');
            if (!listEl) return;

            if (!state.autoTransfers.length) {
                listEl.innerHTML =
                    '<div class="text-center py-10">' +
                        '<i class="fa-solid fa-rotate text-zinc-200 text-3xl mb-3"></i>' +
                        '<p class="text-xs text-zinc-400">등록된 자동이체가 없습니다.</p>' +
                    '</div>';
                renderAutoTransferBadge();
                return;
            }

            listEl.innerHTML = state.autoTransfers.map(row => {
                const paused = !row.active;
                const failNote = (row.fail_count || 0) > 0 && row.last_result && row.last_result !== '성공'
                    ? '<div class="text-[10px] text-red-500 mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>최근 실패: ' + escapeHtml(row.last_result) + '</div>'
                    : '';

                return '<div class="bg-white border ' + (paused ? 'border-zinc-200 opacity-60' : 'border-zinc-200') + ' rounded-2xl p-3.5 shadow-sm">' +
                    '<div class="flex items-start justify-between gap-2">' +
                        '<div class="min-w-0">' +
                            '<div class="flex items-center gap-1.5 flex-wrap">' +
                                '<span class="text-xs font-bold text-zinc-900 truncate">' + escapeHtml(row.to_alias || '') + '</span>' +
                                '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full ' + (paused ? 'bg-zinc-100 text-zinc-500' : 'bg-emerald-50 text-emerald-700') + '">' +
                                    (paused ? '일시정지' : '진행중') +
                                '</span>' +
                            '</div>' +
                            '<div class="text-[10px] text-zinc-400 font-mono mt-0.5">' + escapeHtml(row.to_account_no || '') + '</div>' +
                            (row.memo ? '<div class="text-[10px] text-zinc-500 mt-1 italic">"' + escapeHtml(row.memo) + '"</div>' : '') +
                            failNote +
                        '</div>' +
                        '<div class="text-right shrink-0">' +
                            '<div class="text-sm font-extrabold text-zinc-900">' + formatNumber(row.amount) + '<span class="text-[10px] font-bold ml-0.5">원</span></div>' +
                            '<div class="text-[10px] text-zinc-400 mt-0.5">' + escapeHtml(atCycleLabel(row)) + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="flex items-center justify-between mt-3 pt-2.5 border-t border-zinc-100">' +
                        '<div class="text-[10px] text-zinc-500">다음 이체일 <span class="font-bold text-zinc-700">' + escapeHtml(atPrettyDate(row.next_run_date)) + '</span></div>' +
                        '<div class="flex gap-1.5">' +
                            '<button onclick="toggleAutoTransfer(' + jsArg(row.id) + ')" class="px-2.5 py-1 rounded-lg text-[10px] font-bold ' + (paused ? 'bg-zinc-900 text-white hover:bg-black' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200') + '">' +
                                (paused ? '재개' : '일시정지') +
                            '</button>' +
                            '<button onclick="deleteAutoTransfer(' + jsArg(row.id) + ')" class="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-red-50 text-red-600 hover:bg-red-100">해지</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join('');

            renderAutoTransferBadge();
        }

        function setAutoTransferCycle(cycle) {
            state.autoTransferCycle = cycle;
            const weeklyBtn = document.getElementById('at-cycle-weekly');
            const monthlyBtn = document.getElementById('at-cycle-monthly');
            const onCls = 'py-2.5 rounded-xl text-xs font-bold border transition-all bg-zinc-900 text-white border-zinc-900';
            const offCls = 'py-2.5 rounded-xl text-xs font-bold border transition-all bg-white text-zinc-600 border-zinc-200';

            if (weeklyBtn) weeklyBtn.className = cycle === 'weekly' ? onCls : offCls;
            if (monthlyBtn) monthlyBtn.className = cycle === 'monthly' ? onCls : offCls;

            document.getElementById('at-weekly-wrap').classList.toggle('hidden', cycle !== 'weekly');
            document.getElementById('at-monthly-wrap').classList.toggle('hidden', cycle !== 'monthly');
            updateAutoTransferPreview();
        }

        function updateAutoTransferPreview() {
            const el = document.getElementById('at-preview-date');
            if (!el) return;
            const dateStr = state.autoTransferCycle === 'weekly'
                ? atFirstRunWeekly(parseInt(document.getElementById('at-day-of-week').value, 10))
                : atFirstRunMonthly(parseInt(document.getElementById('at-day-of-month').value, 10));
            el.innerText = atPrettyDate(dateStr);
        }

        function openAutoTransferForm() {
            const user = getCurrentUser();
            const activeAcc = getActiveAccount();
            if (!user || !activeAcc) {
                showToast('출금할 계좌를 먼저 선택해 주세요.');
                return;
            }

            const fromEl = document.getElementById('at-from-account');
            if (fromEl) fromEl.innerText = activeAcc.name + ' (' + activeAcc.accountNo + ')';

            const daySelect = document.getElementById('at-day-of-month');
            if (daySelect && !daySelect.options.length) {
                let opts = '';
                for (let i = 1; i <= 31; i++) opts += '<option value="' + i + '">매월 ' + i + '일</option>';
                daySelect.innerHTML = opts;
            }

            document.getElementById('at-recipient').value = '';
            document.getElementById('at-amount').value = '';
            document.getElementById('at-memo').value = '';
            setAutoTransferCycle('weekly');

            openModal('modal-auto-transfer-form');
        }

        async function submitAutoTransfer() {
            const user = getCurrentUser();
            const activeAcc = getActiveAccount();
            if (!user || !activeAcc) return;

            const recipient = document.getElementById('at-recipient').value.trim();
            const amount = parseAmountInput(document.getElementById('at-amount').value);
            const memo = document.getElementById('at-memo').value.trim();
            const cycle = state.autoTransferCycle;

            if (!recipient) {
                showToast('받는 분을 입력해 주세요.');
                return;
            }
            if (!amount || isNaN(amount) || amount <= 0) {
                showToast('이체 금액을 올바르게 입력해 주세요.');
                return;
            }

            const btn = document.getElementById('at-submit-btn');
            if (btn) { btn.disabled = true; btn.innerText = '확인 중...'; }

            const restoreBtn = () => {
                if (btn) { btn.disabled = false; btn.innerText = '자동이체 등록'; }
            };

            const match = await findRecipientAccountLive(recipient);
            if (match === 'ambiguous') {
                showToast('일치하는 회원이 여러 명 있습니다. UID나 계좌번호로 입력해 주세요.');
                restoreBtn();
                return;
            }
            if (match === 'error') {
                showToast('서버 조회 중 오류가 발생했습니다. 다시 시도해 주세요.');
                restoreBtn();
                return;
            }
            if (!match) {
                showToast('받는 사람을 찾을 수 없습니다. 계좌번호, 이름, 디스코드 ID, UID 중 하나를 정확히 입력해 주세요.');
                restoreBtn();
                return;
            }
            if (match.accountId === activeAcc.id) {
                showToast('본인의 같은 계좌로는 자동이체를 등록할 수 없습니다.');
                restoreBtn();
                return;
            }

            const dayOfWeek = cycle === 'weekly' ? parseInt(document.getElementById('at-day-of-week').value, 10) : null;
            const dayOfMonth = cycle === 'monthly' ? parseInt(document.getElementById('at-day-of-month').value, 10) : null;
            let firstRun = cycle === 'weekly' ? atFirstRunWeekly(dayOfWeek) : atFirstRunMonthly(dayOfMonth);

            try {
                const { data: createData, error } = await authRpc('app_create_auto_transfer', {
                    p_from_account: activeAcc.id,
                    p_to_account: match.accountId,
                    p_amount: amount,
                    p_memo: memo || null,
                    p_cycle: cycle,
                    p_day_of_week: dayOfWeek,
                    p_day_of_month: dayOfMonth
                });

                if (error || !createData || !createData.ok) {
                    console.error('자동이체 등록 오류:', error || createData);
                    const reason = createData && createData.reason;
                    showToast(reason === 'limit_reached'
                        ? '자동이체는 최대 20개까지 등록할 수 있습니다.'
                        : '자동이체 등록 중 오류가 발생했습니다.');
                    restoreBtn();
                    return;
                }
                firstRun = createData.first_run;
            } catch (err) {
                console.error('자동이체 등록 오류:', err);
                showToast('자동이체 등록 중 오류가 발생했습니다.');
                restoreBtn();
                return;
            }

            restoreBtn();
            closeModal('modal-auto-transfer-form');
            await loadAutoTransfers();
            renderAutoTransferList();
            showToast(match.alias + ' 님에게 ' + atPrettyDate(firstRun) + '부터 자동이체가 시작됩니다.');
        }

        async function toggleAutoTransfer(id) {
            const row = state.autoTransfers.find(r => r.id === id);
            if (!row) return;

            const newActive = !row.active;
            const patch = {};

            try {
                const { data: toggleData, error } = await authRpc('app_set_auto_transfer_active', { p_id: id, p_active: newActive });
                if (error || !toggleData || !toggleData.ok) {
                    showToast('상태 변경 중 오류가 발생했습니다.');
                    return;
                }
                if (toggleData.next_run_date) patch.next_run_date = toggleData.next_run_date;
            } catch (err) {
                console.error('자동이체 상태 변경 오류:', err);
                showToast('상태 변경 중 오류가 발생했습니다.');
                return;
            }

            row.active = newActive;
            if (patch.next_run_date) row.next_run_date = patch.next_run_date;
            renderAutoTransferList();
            showToast(newActive ? '자동이체를 재개했습니다.' : '자동이체를 일시정지했습니다.');
        }

        async function deleteAutoTransfer(id) {
            const row = state.autoTransfers.find(r => r.id === id);
            if (!row) return;

            const confirmed = window.confirm("'" + row.to_alias + "' 님에게 보내는 자동이체를 해지하시겠습니까?");
            if (!confirmed) return;

            try {
                const { error } = await authRpc('app_delete_auto_transfer', { p_id: id });
                if (error) {
                    showToast('해지 중 오류가 발생했습니다.');
                    return;
                }
            } catch (err) {
                console.error('자동이체 해지 오류:', err);
                showToast('해지 중 오류가 발생했습니다.');
                return;
            }

            state.autoTransfers = state.autoTransfers.filter(r => r.id !== id);
            renderAutoTransferList();
            showToast('자동이체가 해지되었습니다.');
        }

        async function runInterestCatchup() {
            try {
                await authRpc('app_interest_catchup', {});
            } catch (err) {
                console.error('이자 지급 확인 오류:', err);
            }
        }

        async function runDueAutoTransfers() {
            const user = getCurrentUser();
            if (!user) return;

            let summary;
            try {
                const { data, error } = await authRpc('app_run_due_auto_transfers', {});
                if (error || !data) {
                    if (error) console.error('자동이체 실행 오류:', error);
                    return;
                }
                summary = data;
            } catch (err) {
                console.error('자동이체 실행 오류:', err);
                return;
            }

            const results = Array.isArray(summary.results) ? summary.results : [];
            if (!results.length) return;

            results.forEach(r => {
                if (r.ok) showToast('자동이체 ' + formatNumber(r.amount) + '원 → ' + r.to_alias);
                else showToast('자동이체 실패 (' + r.to_alias + '): ' + r.message);
            });

            await loadUserFinancialData(user.id);
            renderApp();
            refreshNotifBadge();
            await loadAutoTransfers();
        }

        const SETTINGS_KEY = 'kdb_pay_settings_v1';
        const FONT_LABELS = { sm: '작게', md: '보통', lg: '크게' };

        function loadDisplaySettings() {
            try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
            catch (e) { return {}; }
        }

        function saveDisplaySettings(patch) {
            const next = Object.assign(loadDisplaySettings(), patch);
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (e) { }
            return next;
        }

        function applyDisplaySettings() {
            const s = loadDisplaySettings();
            const theme = s.theme === 'dark' ? 'dark' : 'light';
            const fs = (s.fontSize === 'sm' || s.fontSize === 'lg') ? s.fontSize : 'md';
            const root = document.documentElement;
            root.classList.toggle('dark', theme === 'dark');
            root.setAttribute('data-theme', theme);
            root.setAttribute('data-fs', fs);
        }

        function syncDisplayControls() {
            const s = loadDisplaySettings();
            const theme = s.theme === 'dark' ? 'dark' : 'light';
            const fs = (s.fontSize === 'sm' || s.fontSize === 'lg') ? s.fontSize : 'md';
            document.querySelectorAll('[data-theme-opt]').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-theme-opt') === theme);
            });
            document.querySelectorAll('[data-fs-opt]').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-fs-opt') === fs);
            });
            const label = document.getElementById('settings-fs-label');
            if (label) label.innerText = FONT_LABELS[fs];
        }

        function setTheme(theme) {
            saveDisplaySettings({ theme: theme === 'dark' ? 'dark' : 'light' });
            applyDisplaySettings();
            syncDisplayControls();
        }

        function setFontSize(level) {
            saveDisplaySettings({ fontSize: (level === 'sm' || level === 'lg') ? level : 'md' });
            applyDisplaySettings();
            syncDisplayControls();
        }

        function resetDisplaySettings() {
            saveDisplaySettings({ theme: 'light', fontSize: 'md' });
            applyDisplaySettings();
            syncDisplayControls();
            showToast('화면 설정을 기본값으로 되돌렸습니다.');
        }

        function openSettings() {
            const user = getCurrentUser();
            if (!user) return;
            renderSettings();
            const screen = document.getElementById('settings-screen');
            if (screen) {
                screen.classList.add('open');
                screen.setAttribute('aria-hidden', 'false');
                const scroller = screen.querySelector('.settings-scroll');
                if (scroller) scroller.scrollTop = 0;
            }
        }

        function closeSettings() {
            const screen = document.getElementById('settings-screen');
            if (screen) {
                screen.classList.remove('open');
                screen.setAttribute('aria-hidden', 'true');
            }
            closeModal('modal-change-pin');
        }

        function renderSettings() {
            const user = getCurrentUser();
            if (!user) return;

            const setText = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };

            setText('settings-avatar', (user.alias || '-').charAt(0));
            setText('settings-head-alias', user.alias || '-');
            setText('settings-head-discord', user.discord || '-');
            setText('settings-uid', user.uid || '-');

            const acc = getPrimaryAccount();
            setText('settings-account', acc ? (acc.name + ' · ' + acc.accountNo) : '-');
            setText('settings-account-count', ((user.accounts || []).length) + '개');
            setText('settings-points', formatNumber(user.points || 0) + ' P');

            const statusEl = document.getElementById('settings-status');
            if (statusEl) {
                statusEl.innerText = user.isFrozen ? '이용 제한(동결)' : '정상';
                statusEl.className = 'text-xs font-semibold ' + (user.isFrozen ? 'text-red-600' : 'text-emerald-600');
            }
            const adminBadge = document.getElementById('settings-admin-badge');
            if (adminBadge) adminBadge.classList.toggle('hidden', !user.isAdmin);

            const aliasInput = document.getElementById('settings-input-alias');
            const discordInput = document.getElementById('settings-input-discord');
            if (aliasInput) aliasInput.value = user.alias || '';
            if (discordInput) discordInput.value = user.discord || '';

            updateAccountSaveState();
            syncDisplayControls();
        }

        function updateAccountSaveState() {
            const user = getCurrentUser();
            const btn = document.getElementById('settings-save-account-btn');
            if (!user || !btn) return;
            const alias = (document.getElementById('settings-input-alias').value || '').trim();
            const discord = (document.getElementById('settings-input-discord').value || '').trim();
            const changed = alias !== (user.alias || '') || discord !== (user.discord || '');
            btn.disabled = !(changed && alias && discord);
        }

        let _accountSaving = false;
        async function saveAccountInfo() {
            const user = getCurrentUser();
            if (!user || _accountSaving) return;

            const alias = document.getElementById('settings-input-alias').value.trim();
            const discord = document.getElementById('settings-input-discord').value.trim();

            if (!alias) { showToast('가명을 입력해 주세요.'); return; }
            if (!isValidAlias(alias)) { showToast('가명은 20자 이하로, 특수문자(< > \" \' ` \\) 없이 입력해 주세요.'); return; }
            if (!discord) { showToast('디스코드 ID를 입력해 주세요.'); return; }
            if (alias === user.alias && discord === user.discord) return;

            const btn = document.getElementById('settings-save-account-btn');
            _accountSaving = true;
            if (btn) { btn.disabled = true; btn.innerText = '저장 중...'; }

            try {
                if (discord !== user.discord) {
                    const { data: taken, error: dupErr } = await authRpc('app_discord_taken', { p_discord: discord });
                    if (dupErr) throw dupErr;
                    if (taken === true) {
                        showToast('이미 사용 중인 디스코드 ID입니다.');
                        return;
                    }
                }

                const { error: upErr } = await authRpc('app_update_profile', { p_alias: alias, p_discord: discord });
                if (upErr) {
                    if (upErr.code === '23505') { showToast('이미 사용 중인 정보입니다.'); return; }
                    if ((upErr.message || '').includes('invalid_alias')) { showToast('가명은 20자 이하로, 특수문자(< > \" \' ` \\) 없이 입력해 주세요.'); return; }
                    throw upErr;
                }

                const { data: check, error: chkErr } = await authRpc('app_my_profile');
                if (chkErr) throw chkErr;
                if (!check || check.alias !== alias || check.discord !== discord) {
                    showToast('서버에 반영되지 않았습니다. 권한 설정을 확인해 주세요.');
                    return;
                }

                user.alias = alias;
                user.discord = discord;
                saveSession();
                renderApp();
                renderSettings();
                showToast('계정 정보가 변경되었습니다.');
            } catch (err) {
                console.error('계정 정보 변경 오류:', err);
                showToast('계정 정보 변경 중 오류가 발생했습니다.');
            } finally {
                _accountSaving = false;
                if (btn) btn.innerText = '변경사항 저장';
                updateAccountSaveState();
            }
        }

        function sanitizePinInput(el) {
            el.value = (el.value || '').replace(/\D/g, '').slice(0, 4);
            const errEl = document.getElementById('change-pin-error');
            if (errEl) errEl.classList.add('hidden');
        }

        function showChangePinError(msg) {
            const errEl = document.getElementById('change-pin-error');
            if (!errEl) { showToast(msg); return; }
            errEl.innerText = msg;
            errEl.classList.remove('hidden');
        }

        function openChangePinModal() {
            ['change-pin-old', 'change-pin-new', 'change-pin-confirm'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.value = '';
                    el.type = 'password';
                    const icon = el.parentElement && el.parentElement.querySelector('button i');
                    if (icon) { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
                }
            });
            const errEl = document.getElementById('change-pin-error');
            if (errEl) errEl.classList.add('hidden');
            openModal('modal-change-pin');
            setTimeout(() => { const el = document.getElementById('change-pin-old'); if (el) el.focus(); }, 320);
        }

        let _pinChanging = false;
        async function executeChangePin() {
            const user = getCurrentUser();
            if (!user || _pinChanging) return;

            const oldPin = document.getElementById('change-pin-old').value.trim();
            const newPin = document.getElementById('change-pin-new').value.trim();
            const confirmPin = document.getElementById('change-pin-confirm').value.trim();

            if (!/^\d{4}$/.test(oldPin)) { showChangePinError('현재 PIN 4자리를 입력해 주세요.'); return; }
            if (!/^\d{4}$/.test(newPin)) { showChangePinError('새 PIN은 숫자 4자리로 입력해 주세요.'); return; }
            if (newPin !== confirmPin) { showChangePinError('새 PIN이 서로 일치하지 않습니다.'); return; }
            if (newPin === oldPin) { showChangePinError('현재 PIN과 다른 번호를 입력해 주세요.'); return; }

            const btn = document.getElementById('change-pin-btn');
            _pinChanging = true;
            if (btn) { btn.disabled = true; btn.innerText = '변경 중...'; }

            try {
                const { error } = await authRpc('app_change_pin', {
                    p_old_pin: oldPin,
                    p_new_pin: newPin
                });

                if (error) {
                    const msg = error.message || '';
                    if (msg.includes('invalid_credentials')) {
                        showChangePinError('현재 PIN이 일치하지 않습니다.');
                    } else if (msg.includes('same_pin')) {
                        showChangePinError('현재 PIN과 다른 번호를 입력해 주세요.');
                    } else if (msg.includes('invalid_pin')) {
                        showChangePinError('새 PIN은 숫자 4자리로 입력해 주세요.');
                    } else if (error.code === 'PGRST202' || msg.includes('Could not find the function')) {
                        console.error('change_user_pin RPC 없음:', error);
                        showChangePinError('서버에 PIN 변경 기능이 아직 설치되지 않았습니다. (change_user_pin SQL 실행 필요)');
                    } else {
                        console.error('PIN 변경 오류:', error);
                        showChangePinError('PIN 변경 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
                    }
                    return;
                }

                closeModal('modal-change-pin');
                ['change-pin-old', 'change-pin-new', 'change-pin-confirm'].forEach(id => {
                    const el = document.getElementById(id); if (el) el.value = '';
                });
                showToast('PIN 번호가 변경되었습니다. 다음 로그인부터 새 PIN을 사용하세요.');
            } catch (err) {
                console.error('PIN 변경 오류:', err);
                showChangePinError('PIN 변경 중 오류가 발생했습니다. 네트워크를 확인해 주세요.');
            } finally {
                _pinChanging = false;
                if (btn) { btn.disabled = false; btn.innerText = 'PIN 변경하기'; }
            }
        }

        function openModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.remove('hidden-modal');
            }
        }

        function closeModal(modalId, keepSession) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.add('hidden-modal');
            }
            if (modalId === 'modal-transfer' && !keepSession) {
                const user = getCurrentUser();
                if (user && user.sessionAccountId) {
                    user.sessionAccountId = null;
                    renderApp();
                }
            }
        }
