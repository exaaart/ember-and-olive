import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  categories,
  contacts,
  dishById,
  gallery,
  img,
  menu,
  signature,
  srcSet,
  timeline,
} from './data.js'
import {
  MAX_GUESTS,
  bookingConfigured,
  dateLimits,
  formatPhone,
  slotsFor,
  submitBooking,
  validateBooking,
} from './lib/booking.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`

function guestsWord(n) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'гость'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'гостя'
  return 'гостей'
}

function formatDateRu(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })
}

function scrollToId(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

function Photo({ id, alt, sizes = '100vw', className = '', eager = false, widths }) {
  return (
    <img
      className={className}
      src={img(id, 1200)}
      srcSet={srcSet(id, widths)}
      sizes={sizes}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  )
}

function Logo({ className = '' }) {
  return (
    <span className={`logo ${className}`}>
      <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="13" cy="17" r="8.5" fill="var(--ember)" />
        <path
          d="M15 22.5C15.5 13 21 7.5 29 6c-.6 8.4-6 14.6-14 16.5Z"
          fill="var(--olive-light)"
        />
        <path d="M15.4 22c3-4.3 6.7-8.6 11.6-13.4" stroke="var(--char)" strokeWidth="1" fill="none" />
      </svg>
      <span className="logo-word">Ember &amp; Olive</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
const NAV = [
  { id: 'concept', label: 'Концепция' },
  { id: 'menu', label: 'Меню' },
  { id: 'gallery', label: 'Галерея' },
  { id: 'story', label: 'История' },
  { id: 'contacts', label: 'Контакты' },
]

function Header() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const toggleRef = useRef(null)

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('is-locked', open)
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        toggleRef.current?.focus()
      }
    }
    const mq = window.matchMedia('(min-width: 961px)')
    const onMq = () => mq.matches && setOpen(false)
    window.addEventListener('keydown', onKey)
    mq.addEventListener('change', onMq)
    return () => {
      window.removeEventListener('keydown', onKey)
      mq.removeEventListener('change', onMq)
    }
  }, [open])

  return (
    <header className={`site-header ${scrolled || open ? 'is-solid' : ''} ${open ? 'is-open' : ''}`}>
      <div className="header-inner">
        <a href="#top" className="header-logo" aria-label="Ember & Olive — на главную" onClick={() => setOpen(false)}>
          <Logo />
        </a>
        <nav className="header-nav" aria-label="Основная навигация">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`}>
              {n.label}
            </a>
          ))}
        </nav>
        <a href="#booking" className="btn btn-ember btn-sm header-cta">
          Забронировать
        </a>
        <button
          ref={toggleRef}
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="visually-hidden">{open ? 'Закрыть меню' : 'Открыть меню'}</span>
          <span className="menu-toggle-bars" aria-hidden="true" />
        </button>
      </div>

      <div id="mobile-nav" className="mobile-nav" hidden={!open}>
        <nav aria-label="Мобильная навигация">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} onClick={() => setOpen(false)}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="mobile-nav-foot">
          <a href="#booking" className="btn btn-ember" onClick={() => setOpen(false)}>
            Забронировать стол
          </a>
          <a href={contacts.phoneHref} className="mobile-nav-phone">
            {contacts.phone}
          </a>
          <p>{contacts.address}</p>
        </div>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Hero + 3D
// ---------------------------------------------------------------------------
function DishStage({ onOpenDish }) {
  const ref = useRef(null)
  const reduced = useReducedMotion()
  const [state, setState] = useState('loading') // loading | ready | fallback
  const [source, setSource] = useState('procedural')
  const [touch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  useEffect(() => {
    let dispose = null
    let cancelled = false
    import('./three/dishScene.js')
      .then(({ createDishScene }) => {
        if (cancelled || !ref.current) return
        try {
          dispose = createDishScene(ref.current, {
            reducedMotion: reduced,
            onStatus: (s) => {
              if (cancelled) return
              setState('ready')
              setSource(s.source)
            },
          })
        } catch (err) {
          console.info('[Ember & Olive] WebGL недоступен, показана фотография блюда.', err?.message || '')
          setState('fallback')
        }
      })
      .catch(() => setState('fallback'))
    return () => {
      cancelled = true
      if (dispose) dispose()
    }
  }, [reduced])

  return (
    <figure className={`dish-stage is-${state}`} data-source={source}>
      <div className="dish-glow" aria-hidden="true" />
      <div className="dish-canvas-wrap" ref={ref} />
      {state === 'loading' && (
        <div className="dish-loading" role="status">
          <span className="dish-loading-ring" aria-hidden="true" />
          <span className="visually-hidden">Загружаем 3D-блюдо</span>
        </div>
      )}
      {state === 'fallback' && (
        <Photo
          id="1474979266404-7eaacbcd87c5"
          alt="Маринованные оливки в оливковом масле"
          className="dish-fallback"
          sizes="(max-width: 960px) 100vw, 50vw"
          eager
        />
      )}
      <figcaption className="dish-caption">
        <button type="button" className="dish-caption-btn" onClick={onOpenDish}>
          <span className="dish-caption-title">Оливки из Апулии и Крита</span>
          <span className="dish-caption-sub">Ночеллара и каламата под стеклянным клошем в масле первого отжима</span>
        </button>
        {state === 'ready' && (
          <span className="dish-hint" aria-hidden="true">
            {touch ? 'Потяните, чтобы повернуть' : 'Двигайте курсором или потяните блюдо'}
          </span>
        )}
      </figcaption>
    </figure>
  )
}

function Hero({ onOpenDish }) {
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero-grid">
        <div className="hero-copy">
          <h1 id="hero-title" className="hero-title">
            <span className="line">
              <span>Вкус,</span>
            </span>
            <span className="line line-indent">
              <span>ради которого</span>
            </span>
            <span className="line">
              <span>возвращаются</span>
            </span>
          </h1>
          <p className="hero-sub">
            Современная авторская кухня, сезонные ингредиенты и атмосфера, в которой хочется задержаться.
          </p>
          <div className="hero-actions">
            <a href="#menu" className="btn btn-ghost">
              Посмотреть меню
            </a>
            <a href="#booking" className="btn btn-ember">
              Забронировать стол
            </a>
          </div>
        </div>
        <DishStage onOpenDish={onOpenDish} />
      </div>

      <ul className="hero-facts">
        <li>
          <strong>Открытый огонь</strong>
          <span>Дровяная печь и гриль на углях берёзы и вишни</span>
        </li>
        <li>
          <strong>Меню по сезону</strong>
          <span>Обновляем четыре раза в год вместе с фермой</span>
        </li>
        <li>
          <strong>Пятницкая, 18</strong>
          <span>Ежедневно с 12:00, кухня до 22:30</span>
        </li>
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Concept
// ---------------------------------------------------------------------------
function Concept() {
  return (
    <section className="concept tone-bone" id="concept" aria-labelledby="concept-title">
      <div className="container concept-grid">
        <div className="concept-text">
          <h2 id="concept-title" className="h2">
            Ресторан вокруг очага
          </h2>
          <p className="lead">
            В центре зала — дровяная печь и открытая кухня. Мы готовим на живом огне, берём продукты у фермеров
            и меняем меню вместе с сезоном. Свет приглушён, столы стоят свободно, и вечер никуда не торопится.
          </p>
          <dl className="concept-facts">
            <div>
              <dt>Зал</dt>
              <dd>64 места и камерный зал на 12 гостей для частных ужинов</dd>
            </div>
            <div>
              <dt>Стол шефа</dt>
              <dd>8 мест у самой печи и сет из семи подач по четвергам и пятницам</dd>
            </div>
            <div>
              <dt>Винная карта</dt>
              <dd>140 позиций, 30 из них подаём бокалами</dd>
            </div>
          </dl>
        </div>
        <div className="concept-media">
          <div className="arch concept-arch">
            <Photo
              id="1600565193348-f74bd3c7ccdf"
              alt="Повар у открытого огня на кухне ресторана"
              sizes="(max-width: 960px) 80vw, 36vw"
            />
          </div>
          <div className="concept-small">
            <Photo
              id="1414235077428-338989a2e8c0"
              alt="Сервированный стол в зале ресторана"
              sizes="(max-width: 960px) 50vw, 22vw"
              widths={[400, 700, 1000]}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Signature dishes
// ---------------------------------------------------------------------------
function Signature({ onOpen }) {
  return (
    <section className="signature" id="dishes" aria-labelledby="sig-title">
      <div className="container">
        <div className="section-head">
          <h2 id="sig-title" className="h2">
            Что заказывают чаще всего
          </h2>
          <p className="section-note">Пять блюд, за которыми гости возвращаются. Нажмите на блюдо, чтобы увидеть состав и вес.</p>
        </div>
        <div className="sig-grid">
          {signature.map(({ id, layout }) => {
            const d = dishById(id)
            return (
              <button key={id} type="button" className={`sig-item sig-${layout}`} onClick={() => onOpen(d)}>
                <span className={`sig-media ${layout === 'arch' ? 'arch' : ''}`}>
                  <Photo
                    id={d.photo}
                    alt=""
                    sizes={layout === 'hero' ? '(max-width: 960px) 100vw, 58vw' : '(max-width: 960px) 100vw, 34vw'}
                  />
                </span>
                <span className="sig-body">
                  <span className="sig-name">{d.name}</span>
                  <span className="sig-desc">{d.short}</span>
                  <span className="sig-price">{rub(d.price)}</span>
                </span>
              </button>
            )
          })}
          <aside className="sig-quote">
            <p>
              «Стриплойн жарим только на углях берёзы и вишни, а отдыхает он ровно столько, сколько жарился.»
            </p>
            <span>Мирон Ларин, шеф</span>
          </aside>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function MenuSection({ onOpen }) {
  const [cat, setCat] = useState(categories[0].id)
  const items = useMemo(() => menu.filter((d) => d.cat === cat), [cat])
  const catInfo = categories.find((c) => c.id === cat)
  const [preview, setPreview] = useState(null)
  const tabRefs = useRef([])
  const baseId = useId()

  useEffect(() => setPreview(null), [cat])

  const shown = preview || items.find((d) => d.photo) || null
  const shownPhoto = shown?.photo || catInfo.photo

  const onTabKey = (e, i) => {
    let next = null
    if (e.key === 'ArrowRight') next = (i + 1) % categories.length
    if (e.key === 'ArrowLeft') next = (i - 1 + categories.length) % categories.length
    if (e.key === 'Home') next = 0
    if (e.key === 'End') next = categories.length - 1
    if (next === null) return
    e.preventDefault()
    setCat(categories[next].id)
    tabRefs.current[next]?.focus()
  }

  return (
    <section className="menu tone-walnut" id="menu" aria-labelledby="menu-title">
      <div className="container">
        <div className="menu-head">
          <h2 id="menu-title" className="h2">
            Меню
          </h2>
          <p className="section-note">
            Цены в рублях. Расскажите официанту об аллергии — шеф адаптирует блюдо.
          </p>
        </div>

        <div className="menu-tabs" role="tablist" aria-label="Категории меню">
          {categories.map((c, i) => (
            <button
              key={c.id}
              ref={(el) => (tabRefs.current[i] = el)}
              type="button"
              role="tab"
              id={`${baseId}-tab-${c.id}`}
              aria-selected={cat === c.id}
              aria-controls={`${baseId}-panel`}
              tabIndex={cat === c.id ? 0 : -1}
              className="menu-tab"
              onClick={() => setCat(c.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {c.label}
              <span className="menu-tab-count">{menu.filter((d) => d.cat === c.id).length}</span>
            </button>
          ))}
        </div>

        <div className="menu-body">
          <div className="menu-preview" aria-hidden="true">
            <div className="arch menu-preview-frame">
              <img
                key={shownPhoto}
                src={img(shownPhoto, 900)}
                srcSet={srcSet(shownPhoto, [500, 900, 1300])}
                sizes="(max-width: 960px) 0px, 30vw"
                alt=""
                className="menu-preview-img"
                decoding="async"
              />
            </div>
            <p className="menu-preview-cap">{shown?.name || catInfo.label}</p>
          </div>

          <ul
            className="menu-list"
            role="tabpanel"
            id={`${baseId}-panel`}
            aria-labelledby={`${baseId}-tab-${cat}`}
            key={cat}
          >
            {items.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="menu-row"
                  onClick={() => onOpen(d)}
                  onMouseEnter={() => d.photo && setPreview(d)}
                  onFocus={() => d.photo && setPreview(d)}
                  aria-haspopup="dialog"
                >
                  <span className="menu-row-main">
                    <span className="menu-row-name">
                      {d.name}
                      {d.tags.map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                    </span>
                    <span className="menu-row-desc">{d.short}</span>
                  </span>
                  <span className="menu-row-leader" aria-hidden="true" />
                  <span className="menu-row-price">{rub(d.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Dish dialog
// ---------------------------------------------------------------------------
function DishDialog({ dish, onClose, onBook }) {
  const ref = useRef(null)

  useEffect(() => {
    const dlg = ref.current
    if (!dlg) return
    if (dish && !dlg.open) dlg.showModal()
    if (!dish && dlg.open) dlg.close()
  }, [dish])

  const photo = dish ? dish.photo || categories.find((c) => c.id === dish.cat)?.photo : null
  const catLabel = dish ? categories.find((c) => c.id === dish.cat)?.label : ''

  return (
    <dialog
      ref={ref}
      className="dish-dialog"
      aria-labelledby="dish-dialog-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {dish && (
        <div className="dish-dialog-inner">
          <div className="dish-dialog-media">
            <img src={img(photo, 1100)} srcSet={srcSet(photo, [600, 1100, 1600])} sizes="(max-width: 760px) 100vw, 50vw" alt={dish.name} />
          </div>
          <div className="dish-dialog-body">
            <p className="dish-dialog-cat">{catLabel}</p>
            <h3 id="dish-dialog-title" className="dish-dialog-title">
              {dish.name}
            </h3>
            {dish.tags.length > 0 && (
              <p className="dish-dialog-tags">
                {dish.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </p>
            )}
            <p className="dish-dialog-short">{dish.short}</p>
            <p className="dish-dialog-long">{dish.long}</p>
            <dl className="dish-dialog-meta">
              <div>
                <dt>Выход</dt>
                <dd>{dish.weight}</dd>
              </div>
              <div>
                <dt>Аллергены</dt>
                <dd>{dish.allergens}</dd>
              </div>
              <div>
                <dt>Цена</dt>
                <dd>{rub(dish.price)}</dd>
              </div>
            </dl>
            <div className="dish-dialog-actions">
              <button type="button" className="btn btn-ember" onClick={onBook}>
                Забронировать стол
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Закрыть
              </button>
            </div>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Закрыть карточку блюда">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Gallery + lightbox
// ---------------------------------------------------------------------------
function Gallery() {
  const [index, setIndex] = useState(-1)
  const ref = useRef(null)
  const open = index >= 0

  useEffect(() => {
    const dlg = ref.current
    if (!dlg) return
    if (open && !dlg.open) dlg.showModal()
    if (!open && dlg.open) dlg.close()
  }, [open])

  const step = useCallback((dir) => setIndex((i) => (i + dir + gallery.length) % gallery.length), [])

  const onKey = (e) => {
    if (e.key === 'ArrowRight') step(1)
    if (e.key === 'ArrowLeft') step(-1)
  }

  const cur = open ? gallery[index] : null

  return (
    <section className="gallery" id="gallery" aria-labelledby="gallery-title">
      <div className="container">
        <div className="section-head">
          <h2 id="gallery-title" className="h2">
            Зал и кухня
          </h2>
          <p className="section-note">Тёплое дерево, низкий свет и печь, которую видно с любого места в зале.</p>
        </div>
        <ul className="gallery-grid">
          {gallery.map((g, i) => (
            <li key={g.photo} className={g.layout}>
              <button type="button" className="gallery-item" onClick={() => setIndex(i)} aria-label={`Открыть фото: ${g.alt}`}>
                <Photo id={g.photo} alt="" sizes="(max-width: 760px) 100vw, (max-width: 1200px) 50vw, 33vw" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <dialog
        ref={ref}
        className="lightbox"
        aria-label="Просмотр фотографий"
        onClose={() => setIndex(-1)}
        onKeyDown={onKey}
        onClick={(e) => e.target === ref.current && setIndex(-1)}
      >
        {cur && (
          <figure className="lightbox-figure">
            <img src={img(cur.photo, 1800, 80)} alt={cur.alt} />
            <figcaption>
              <span>{cur.alt}</span>
              <span className="lightbox-count">
                {index + 1} из {gallery.length}
              </span>
            </figcaption>
          </figure>
        )}
        <button type="button" className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Предыдущее фото">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <button type="button" className="lightbox-nav next" onClick={() => step(1)} aria-label="Следующее фото">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
        <button type="button" className="dialog-close" onClick={() => setIndex(-1)} aria-label="Закрыть просмотр">
          <span aria-hidden="true">×</span>
        </button>
      </dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------
const PRINCIPLES = [
  {
    title: 'Продукт важнее рецепта',
    text: 'Сначала узнаём, что сегодня лучшее на ферме, и только потом решаем, что из этого приготовить.',
  },
  {
    title: 'Огонь — тоже приправа',
    text: 'Берёза, вишня и яблоня дают разный дым. Под каждое блюдо мы подбираем своё дерево.',
  },
  {
    title: 'Ничего лишнего',
    text: 'Из обрезков варим бульоны, из косточек делаем масла, излишки урожая ферментируем на зиму.',
  },
]

function Story() {
  return (
    <section className="story tone-bone" id="story" aria-labelledby="story-title">
      <div className="container">
        <div className="story-top">
          <div className="arch story-arch">
            <Photo id="1577219491135-ce391730fb2c" alt="Шеф ресторана за работой на кухне" sizes="(max-width: 960px) 80vw, 34vw" />
          </div>
          <div className="story-intro">
            <h2 id="story-title" className="h2">
              История и философия
            </h2>
            <blockquote className="story-quote">
              <p>«Огонь не прощает спешки. Он учит ждать, и поэтому у нас вкусно.»</p>
              <footer>Мирон Ларин, шеф и основатель</footer>
            </blockquote>
          </div>
        </div>

        <ol className="timeline">
          {timeline.map((t) => (
            <li key={t.year}>
              <span className="timeline-year">{t.year}</span>
              <h3 className="timeline-title">{t.title}</h3>
              <p>{t.text}</p>
            </li>
          ))}
        </ol>

        <div className="principles">
          <h3 className="principles-title">Как мы готовим</h3>
          <div className="principles-list">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="principle">
                <h4>{p.title}</h4>
                <p>{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------
const EMPTY_FORM = { name: '', phone: '', date: '', time: '', guests: 2, comment: '', consent: false }

function Field({ id, label, error, hint, children, className = '' }) {
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  )
}

function Booking() {
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState(false)
  const [status, setStatus] = useState('idle') // idle | submitting | sent | not_configured | error
  const [errorMsg, setErrorMsg] = useState('')
  const resultRef = useRef(null)
  const formRef = useRef(null)
  const limits = useMemo(() => dateLimits(), [])
  const slots = useMemo(() => slotsFor(form.date), [form.date])

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => {
      const next = { ...f, [k]: k === 'phone' ? formatPhone(v) : v }
      if (k === 'date' && next.time && !slotsFor(next.date).includes(next.time)) next.time = ''
      if (touched) setErrors(validateBooking(next))
      return next
    })
  }

  const setGuests = (n) => {
    const g = Math.min(MAX_GUESTS, Math.max(1, n))
    setForm((f) => {
      const next = { ...f, guests: g }
      if (touched) setErrors(validateBooking(next))
      return next
    })
  }

  useEffect(() => {
    if (status !== 'idle' && status !== 'submitting') resultRef.current?.focus()
  }, [status])

  const onSubmit = async (e) => {
    e.preventDefault()
    setTouched(true)
    const errs = validateBooking(form)
    setErrors(errs)
    const first = Object.keys(errs)[0]
    if (first) {
      const el = formRef.current?.querySelector(`[name="${first}"]`)
      el?.focus()
      return
    }
    setStatus('submitting')
    const res = await submitBooking(form)
    if (res.status === 'error') setErrorMsg(res.message)
    setStatus(res.status)
  }

  const reset = (keep = true) => {
    setStatus('idle')
    if (!keep) {
      setForm(EMPTY_FORM)
      setTouched(false)
      setErrors({})
    }
  }

  const summary = `${formatDateRu(form.date)}, ${form.time}, ${form.guests} ${guestsWord(Number(form.guests))}`
  const describe = (k, hint) => (errors[k] ? `bk-${k}-error` : hint ? `bk-${k}-hint` : undefined)

  return (
    <section className="booking" id="booking" aria-labelledby="booking-title">
      <div className="booking-bg" aria-hidden="true">
        <Photo id="1578474846511-04ba529f0b88" alt="" sizes="100vw" />
      </div>
      <div className="container booking-grid">
        <div className="booking-info">
          <h2 id="booking-title" className="h2">
            Забронировать стол
          </h2>
          <p className="lead-sm">
            Выберите дату, время и количество гостей. Бронь подтверждает администратор — по телефону, в течение
            пятнадцати минут в часы работы ресторана.
          </p>
          <dl className="booking-facts">
            <div>
              <dt>Быстрее всего по телефону</dt>
              <dd>
                <a href={contacts.phoneHref}>{contacts.phone}</a>
              </dd>
            </div>
            <div>
              <dt>Компании от 12 гостей</dt>
              <dd>Камерный зал и банкетное меню — обсудим по телефону</dd>
            </div>
            <div>
              <dt>Стол держим</dt>
              <dd>15 минут после времени брони</dd>
            </div>
          </dl>
        </div>

        <div className="booking-card">
          {status === 'idle' || status === 'submitting' ? (
            <form ref={formRef} className="booking-form" noValidate onSubmit={onSubmit}>
              <div className="form-row">
                <Field id="bk-name" label="Имя" error={errors.name}>
                  <input
                    id="bk-name"
                    name="name"
                    autoComplete="name"
                    value={form.name}
                    onChange={set('name')}
                    aria-invalid={!!errors.name}
                    aria-describedby={describe('name')}
                  />
                </Field>
                <Field id="bk-phone" label="Телефон" error={errors.phone}>
                  <input
                    id="bk-phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+7 (___) ___-__-__"
                    value={form.phone}
                    onChange={set('phone')}
                    aria-invalid={!!errors.phone}
                    aria-describedby={describe('phone')}
                  />
                </Field>
              </div>

              <div className="form-row form-row-3">
                <Field id="bk-date" label="Дата" error={errors.date}>
                  <input
                    id="bk-date"
                    name="date"
                    type="date"
                    min={limits.min}
                    max={limits.max}
                    value={form.date}
                    onChange={set('date')}
                    aria-invalid={!!errors.date}
                    aria-describedby={describe('date')}
                  />
                </Field>
                <Field id="bk-time" label="Время" error={errors.time}>
                  <select
                    id="bk-time"
                    name="time"
                    value={form.time}
                    onChange={set('time')}
                    aria-invalid={!!errors.time}
                    aria-describedby={describe('time')}
                  >
                    <option value="">{slots.length ? 'Выберите' : 'Сегодня мест нет'}</option>
                    {slots.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="bk-guests" label="Гости" error={errors.guests}>
                  <div className="stepper">
                    <button
                      type="button"
                      onClick={() => setGuests(Number(form.guests) - 1)}
                      disabled={Number(form.guests) <= 1}
                      aria-label="Меньше гостей"
                    >
                      −
                    </button>
                    <input
                      id="bk-guests"
                      name="guests"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max={MAX_GUESTS}
                      value={form.guests}
                      onChange={(e) => {
                        const v = e.target.value
                        setForm((f) => {
                          const next = { ...f, guests: v === '' ? '' : Number(v) }
                          if (touched) setErrors(validateBooking(next))
                          return next
                        })
                      }}
                      aria-invalid={!!errors.guests}
                      aria-describedby={describe('guests')}
                    />
                    <button
                      type="button"
                      onClick={() => setGuests(Number(form.guests) + 1)}
                      disabled={Number(form.guests) >= MAX_GUESTS}
                      aria-label="Больше гостей"
                    >
                      +
                    </button>
                  </div>
                </Field>
              </div>

              <Field
                id="bk-comment"
                label="Пожелания"
                error={errors.comment}
                hint="Необязательно: повод, стол у окна, детский стульчик"
              >
                <textarea
                  id="bk-comment"
                  name="comment"
                  rows={3}
                  maxLength={600}
                  value={form.comment}
                  onChange={set('comment')}
                  aria-invalid={!!errors.comment}
                  aria-describedby={describe('comment', true)}
                />
              </Field>

              <div className={`field field-check ${errors.consent ? 'has-error' : ''}`}>
                <label className="check">
                  <input
                    type="checkbox"
                    name="consent"
                    checked={form.consent}
                    onChange={set('consent')}
                    aria-invalid={!!errors.consent}
                    aria-describedby={errors.consent ? 'bk-consent-error' : undefined}
                  />
                  <span>Согласен на обработку персональных данных для подтверждения брони</span>
                </label>
                {errors.consent && (
                  <p className="field-error" id="bk-consent-error">
                    {errors.consent}
                  </p>
                )}
              </div>

              <div className="form-submit">
                <button type="submit" className="btn btn-ember btn-lg" disabled={status === 'submitting'}>
                  {status === 'submitting' ? 'Отправляем заявку…' : 'Отправить заявку'}
                </button>
                {!bookingConfigured && (
                  <p className="form-demo-note">
                    Демо-режим: онлайн-бронь ещё не подключена к системе ресторана. Форма проверит данные, но не
                    отправит их.
                  </p>
                )}
              </div>
            </form>
          ) : (
            <div className={`booking-result is-${status}`} ref={resultRef} tabIndex={-1} role="status" aria-live="polite">
              {status === 'sent' && (
                <>
                  <h3>Заявка отправлена</h3>
                  <p>
                    Мы получили заявку на {summary}. Администратор позвонит на номер {form.phone}, чтобы подтвердить
                    бронь. До звонка бронь не считается подтверждённой.
                  </p>
                  <div className="result-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => reset(false)}>
                      Новая заявка
                    </button>
                  </div>
                </>
              )}
              {status === 'not_configured' && (
                <>
                  <h3>Заявка не отправлена</h3>
                  <p>
                    Данные заполнены верно, но онлайн-бронирование пока не подключено к системе ресторана, поэтому
                    заявку никто не получил. Позвоните нам, и мы забронируем этот стол по телефону.
                  </p>
                  <dl className="result-summary">
                    <div>
                      <dt>Когда</dt>
                      <dd>
                        {formatDateRu(form.date)}, {form.time}
                      </dd>
                    </div>
                    <div>
                      <dt>Гости</dt>
                      <dd>
                        {form.guests} {guestsWord(Number(form.guests))}
                      </dd>
                    </div>
                    <div>
                      <dt>На имя</dt>
                      <dd>{form.name.trim()}</dd>
                    </div>
                  </dl>
                  <div className="result-actions">
                    <a href={contacts.phoneHref} className="btn btn-ember">
                      Позвонить {contacts.phone}
                    </a>
                    <button type="button" className="btn btn-ghost" onClick={() => reset(true)}>
                      Изменить заявку
                    </button>
                  </div>
                </>
              )}
              {status === 'error' && (
                <>
                  <h3>Заявка не отправлена</h3>
                  <p>{errorMsg} Попробуйте ещё раз через минуту или позвоните нам.</p>
                  <div className="result-actions">
                    <button type="button" className="btn btn-ember" onClick={() => reset(true)}>
                      Попробовать ещё раз
                    </button>
                    <a href={contacts.phoneHref} className="btn btn-ghost">
                      Позвонить
                    </a>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
function Contacts() {
  const { lat, lon } = contacts.map
  const d = 0.006
  const bbox = [lon - d * 1.8, lat - d, lon + d * 1.8, lat + d].join(',')
  const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`
  const routeHref = `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`

  return (
    <section className="contacts" id="contacts" aria-labelledby="contacts-title">
      <div className="container contacts-grid">
        <div className="contacts-info">
          <h2 id="contacts-title" className="h2">
            Как нас найти
          </h2>
          <dl className="contacts-list">
            <div>
              <dt>Адрес</dt>
              <dd>
                {contacts.address}
                <span>{contacts.addressNote}</span>
              </dd>
            </div>
            <div>
              <dt>Телефон</dt>
              <dd>
                <a href={contacts.phoneHref}>{contacts.phone}</a>
                <span>
                  <a href={`mailto:${contacts.email}`}>{contacts.email}</a>
                </span>
              </dd>
            </div>
            <div>
              <dt>Часы работы</dt>
              <dd>
                <ul className="hours">
                  {contacts.hours.map((h) => (
                    <li key={h.days}>
                      <span>{h.days}</span>
                      <span>{h.time}</span>
                    </li>
                  ))}
                </ul>
                <span>{contacts.kitchenNote}</span>
              </dd>
            </div>
            <div>
              <dt>Парковка</dt>
              <dd>Городская платная парковка во дворе и на Пятницкой</dd>
            </div>
          </dl>
          <a className="btn btn-ghost" href={routeHref} target="_blank" rel="noopener noreferrer">
            Построить маршрут в Яндекс Картах
          </a>
        </div>
        <div className="contacts-map">
          <iframe
            title="Карта: Ember & Olive на Пятницкой улице"
            src={mapSrc}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p className="footer-word" aria-hidden="true">
          Ember <span>&amp;</span> Olive
        </p>
        <div className="footer-grid">
          <div>
            <Logo />
            <p className="footer-tag">Авторская кухня на живом огне</p>
          </div>
          <nav aria-label="Навигация в подвале">
            <ul>
              {NAV.map((n) => (
                <li key={n.id}>
                  <a href={`#${n.id}`}>{n.label}</a>
                </li>
              ))}
              <li>
                <a href="#booking">Бронирование</a>
              </li>
            </ul>
          </nav>
          <div className="footer-contacts">
            <a href={contacts.phoneHref}>{contacts.phone}</a>
            <span>{contacts.address}</span>
            <span>Ежедневно с 12:00</span>
          </div>
        </div>
        <p className="footer-legal">
          © {new Date().getFullYear()} Ember &amp; Olive. Концепт-проект веб-студии: название, адрес и телефон
          вымышлены. Фотографии — Unsplash. 3D-модель — Wayfair / Khronos (CC BY 4.0).
        </p>
      </div>
    </footer>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [dish, setDish] = useState(null)

  const openDish = useCallback((d) => setDish(d), [])
  const closeDish = useCallback(() => setDish(null), [])
  const bookFromDish = useCallback(() => {
    setDish(null)
    requestAnimationFrame(() => scrollToId('booking'))
  }, [])

  return (
    <>
      <a href="#main" className="skip-link">
        Перейти к содержимому
      </a>
      <Header />
      <main id="main">
        <Hero onOpenDish={() => openDish(dishById('olives'))} />
        <Concept />
        <Signature onOpen={openDish} />
        <MenuSection onOpen={openDish} />
        <Gallery />
        <Story />
        <Booking />
        <Contacts />
      </main>
      <Footer />
      <DishDialog dish={dish} onClose={closeDish} onBook={bookFromDish} />
    </>
  )
}
