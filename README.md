# SigApp Migration: Supabase → Firebase

**Herramienta especializada para migrar datos de calificaciones y preferencias desde Supabase (PostgreSQL) hacia Cloud Firestore.**

Convierte estructura relacional a NoSQL optimizada para acceso offline-first en aplicaciones Flutter.

## 🚀 Inicio Rápido (Clone & Run)

### Prerrequisitos

- **Bun 1.2.20+** instalado
- **Acceso a proyecto Firebase** con Admin SDK
- **Acceso a base Supabase** (solo para migración inicial)

### 1. Clonar y preparar

```bash
git clone https://github.com/sigapp-unp/sigapp-supabase-to-firebase-migration.git
cd sigapp-supabase-to-firebase-migration
bun install
```

### 2. Configurar credenciales

Crear archivo `.env` en la raíz del proyecto:

```env
# ==================== FIREBASE ====================
# Ruta al archivo JSON del Service Account de Firebase
FIREBASE_SERVICE_ACCOUNT_PATH=./sigapp-dev-firebase-adminsdk.json

# ==================== SUPABASE ====================
# URL y clave de servicio para lectura de datos
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sbk_xxxxxxxxxxxxx

# ==================== MIGRACIÓN ====================
# Filtrar registros desde esta fecha (opcional)
MIGRATE_SINCE=2025-01-01T00:00:00Z

# Configuración de rendimiento
PAGE_SIZE=500
CONCURRENCY=20

# Estructura de datos en Firestore
STRUCTURE_MODE=embedded

# Modo de prueba (true = no escribe a Firestore)
DRY_RUN=false
```

### 3. Obtener Service Account de Firebase

1. Ir a [Firebase Console](https://console.firebase.google.com)
2. Proyecto → ⚙️ Configuración → Cuentas de servicio
3. Generar nueva clave privada → Descargar JSON
4. Guardar como `sigapp-dev-firebase-adminsdk.json` (o el nombre en tu `.env`)

### 4. Ejecutar migración

**Prueba en seco (recomendado primero):**

```bash
DRY_RUN=true bun main.ts
```

**Migración real:**

```bash
bun main.ts
```

## 📁 Archivos Importantes (.gitignored)

El sistema genera archivos que **NO se commitean** pero son cruciales para la operación:

### 🔐 **Archivos de Credenciales**

```
*firebase-adminsdk.json    # Service Account de Firebase (SECRETO)
.env                       # Variables de entorno con claves
```

### 📊 **Archivos de Control**

```
checkpoint.json            # Estado de progreso de migración
checkpoint.json.bak        # Backup automático del checkpoint
```

- **Propósito:** Permite reanudar migración desde donde quedó si se interrumpe
- **Contiene:** Página actual, registros procesados, timestamp
- **Regenerable:** Se puede eliminar para empezar desde cero

### 📝 **Archivos de Log**

```
failed.jsonl               # Errores críticos durante migración
issues.jsonl               # Problemas de integridad de datos
```

- **`failed.jsonl`**: Fallos de escritura, errores de conexión, documentos oversized
- **`issues.jsonl`**: Cursos sin categorías, categorías sin notas (normales)

## 🔧 Configuración Avanzada

### Variables de Entorno Completas

```env
# === OBLIGATORIAS ===
FIREBASE_SERVICE_ACCOUNT_PATH=./tu-service-account.json
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sbk_xxxxx

# === OPCIONALES ===
MIGRATE_SINCE=2025-01-01T00:00:00Z    # Migrar solo desde esta fecha
PAGE_SIZE=500                         # Registros por página
CONCURRENCY=20                        # Operaciones paralelas
STRUCTURE_MODE=embedded               # embedded | subcollections
DRY_RUN=false                         # true = no escribe nada
DEBUG_LIMIT=1000                      # Limitar registros para pruebas
CHECKPOINT_PATH=./checkpoint.json     # Ruta del checkpoint
FAILED_PATH=./failed.jsonl           # Ruta de logs de errores
```

### Estructura de Datos Migrada

**Desde Supabase (Relacional):**

```sql
gt_course_tracking          → /students/{studentCode}/gradeSimulations/{courseCode}
├── gt_grade_categories     → categories: Map<string, {name, weight}>
└── gt_grades              → grades: Map<string, {categoryIndex, name, score, enabled}>

user_preferences            → /students/{studentCode}/preferences/
├── global                 → /preferences/global
└── _semesters/data/       → /preferences/_semesters/data/{semesterId}
```

**Hacia Firestore (NoSQL Embebido):**

```
/students/{studentCode}/
├── gradeSimulations/{courseCode}/
│   ├── categories: {"0": {name: "Parciales", weight: 0.4}, ...}
│   ├── grades: {"0": {categoryIndex: 0, name: "Parcial 1", score: 85, enabled: true}, ...}
│   └── lastModified: timestamp
└── preferences/
    ├── global: {courseChain: {highlightCriticalPath: false, viewMode: "tree"}, ...}
    └── _semesters/data/{semesterId}: {scheduleHiddenEvents: [...]}
```

## 🛠️ Comandos Útiles

### Testing de conexión

```bash
# Probar solo conexión a Firebase
bun test-firestore.ts

# Migración de prueba (primeras 100 filas)
DEBUG_LIMIT=100 DRY_RUN=true bun main.ts
```

### Reanudar migración

```bash
# Continúa desde checkpoint.json automáticamente
bun main.ts

# Empezar desde cero (eliminar checkpoint)
rm checkpoint.json && bun main.ts
```

### Análisis de problemas

```bash
# Ver errores críticos
cat failed.jsonl | head -10

# Ver issues de integridad (normal)
cat issues.jsonl | head -10

# Estadísticas de issues
cat issues.jsonl | cut -d'"' -f4 | sort | uniq -c
```

## 📊 Interpretación de Resultados

### Salida Normal

```
📊 NEW documents created: 6795
📊 EXISTING documents skipped: 0
📊 Direct writes executed: 6814
⚠️  Data integrity issues: 15 (see issues.jsonl)
   category_no_grades: 12
   no_categories: 3
✅ Success rate: 100%
```

### Issues Comunes (No son errores)

- **`no_categories`**: Cursos recién creados sin categorías de calificación
- **`category_no_grades`**: Categorías preparadas pero sin notas ingresadas
- **`oversized_doc`**: Documentos > 1MB, migrados como subcollections

## 🚨 Solución de Problemas

### Error: "Firebase permissions denied"

```bash
# Verificar que el Service Account tenga permisos
# En Firebase Console: IAM → Agregar "Firebase Admin SDK Administrator Service Agent"
```

### Error: "Supabase connection timeout"

```bash
# Verificar la clave de servicio y URL
# Reducir concurrencia: CONCURRENCY=5
```

### Migración se detiene

```bash
# Verificar logs
cat failed.jsonl

# Reanudar (automático desde checkpoint)
bun main.ts
```

---

**⚠️ Importante:** Nunca commitear archivos `.env`, `*firebase-adminsdk.json` o logs con datos sensibles.
