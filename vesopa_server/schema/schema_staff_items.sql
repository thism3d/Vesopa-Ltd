-- Staff items: a drink bought for a member of staff prints a slip (2026-10-30).
--
-- Nicky: "a check box on the product to say Staff Item. If this box is enabled
-- when they sell that item it will print out a slip with a barcode and voucher
-- code. This is then for the member of staff to keep and scan or tap the code
-- in to redeem their drink. Basically there's a big scam with staff saying they
-- have drinks bought for them off customers."
--
--   bo_products.staff_item   ringing it up and paying prints one slip per item
--   epos_staff_drinks        each slip: what it was for, who sold it, and when
--                            and where it was redeemed (once only)
--
-- Off for every product until the venue ticks the box.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN t VARCHAR(64), IN c VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD COLUMN `', c, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_column('bo_products', 'staff_item', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;

CREATE TABLE IF NOT EXISTS epos_staff_drinks (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  office            VARCHAR(190) NOT NULL,
  code              VARCHAR(20)  NOT NULL,
  plu_id            INT          NULL,
  product_name      VARCHAR(255) NOT NULL,
  price_minor       INT          NOT NULL DEFAULT 0,
  order_id          VARCHAR(64)  NULL,
  terminal          VARCHAR(120) NULL,
  sold_by           VARCHAR(120) NULL,
  issued_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  redeemed_at       DATETIME     NULL,
  redeemed_by       VARCHAR(120) NULL,
  redeemed_terminal VARCHAR(120) NULL,
  UNIQUE KEY uq_staff_drink_code (office, code),
  KEY ix_staff_drink_issued (office, issued_at)
);
