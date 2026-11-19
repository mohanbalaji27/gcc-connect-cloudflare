-- Additive only: existing menu rows and likes keep working. The meal id `snacks` stays and is shown as "Evening snacks".
-- Course (section), order within the day, "special" flag and a change stamp for the bulk menu editor.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'menu_items' AND column_name = 'course') THEN
    ALTER TABLE menu_items ADD COLUMN course TEXT NOT NULL DEFAULT 'mains';
    -- One-time, best-effort mapping of dishes that were added before sections existed.
    UPDATE menu_items SET course = CASE
      WHEN name ~* '^\s*((masala|filter|green|iced|hot|cold|fresh|sweet|salted)\s+)?(tea|chai|coffee|juice|lassi|buttermilk|milkshake|shake|soda|lemonade|coconut water)(\s|$)' OR name ~* '\yjuice\s*$' THEN 'drinks'
      WHEN name ~* '\y(halwa|kheer|payasam|payasa|gulab jamun|rasmalai|rasgulla|jalebi|laddu|ladoo|brownie|pudding|mousse|ice ?cream|cake|dessert)\y' THEN 'desserts'
      ELSE 'mains' END;
  END IF;
END $$;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One review per person per meal per day (item_id IS NULL), plus optional star ratings for single dishes.
CREATE TABLE IF NOT EXISTS menu_reviews (
  id TEXT PRIMARY KEY,
  menu_date DATE NOT NULL,
  meal TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'snacks', 'dinner')),
  item_id TEXT REFERENCES menu_items(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  anonymous BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS menu_reviews_meal_uq ON menu_reviews(employee_id, menu_date, meal) WHERE item_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS menu_reviews_dish_uq ON menu_reviews(employee_id, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS menu_reviews_day_idx ON menu_reviews(menu_date, meal);

-- "Save this day as a template" for the weekly repeating menu.
CREATE TABLE IF NOT EXISTS menu_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS menu_templates_name_uq ON menu_templates (lower(name));
