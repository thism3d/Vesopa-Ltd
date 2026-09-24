-- phpMyAdmin SQL Dump
-- version 5.2.0
-- https://www.phpmyadmin.net/
--
-- Host: localhost:8889
-- Generation Time: Jul 18, 2026 at 09:27 AM
-- Server version: 5.7.39
-- PHP Version: 8.2.0

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `vesopa_eposdb`
--

-- --------------------------------------------------------

--
-- Table structure for table `admin_table`
--

CREATE TABLE `admin_table` (
  `id` int(11) NOT NULL,
  `dateadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `fullname` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `public_key` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `enabled` enum('Y','N') COLLATE utf8mb4_unicode_ci DEFAULT 'Y'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `admin_table`
--

INSERT INTO `admin_table` (`id`, `dateadded`, `fullname`, `username`, `public_key`, `country`, `status`, `password`, `enabled`) VALUES
(6, '2022-02-23 15:29:31', 'Vesopa EPOS Admin', 'vesopa2024', '98126479162376412537178', 'England', 'Admin', 'vesopa2024', 'Y');

-- --------------------------------------------------------

--
-- Table structure for table `backoffice_users`
--

CREATE TABLE `backoffice_users` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `email` varchar(255) COLLATE utf8_unicode_ci NOT NULL,
  `password` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8_unicode_ci NOT NULL,
  `company` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `approved` enum('Y','N') COLLATE utf8_unicode_ci NOT NULL DEFAULT 'N',
  `office_id` int(11) DEFAULT NULL,
  `role` enum('admin','office') COLLATE utf8_unicode_ci NOT NULL DEFAULT 'office'
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

--
-- Dumping data for table `backoffice_users`
--

INSERT INTO `backoffice_users` (`timeadded`, `id`, `email`, `password`, `name`, `company`, `approved`, `office_id`, `role`) VALUES
('2024-12-17 09:25:55', 1, 'muzahid@onzep.uk', '$2b$12$Gohu9OWCc5s8AMpIISo/Vu5AjGrxbjEfI3JH2NtxyUaDToakOYcAy', 'Md Muzahidul Islam', NULL, 'Y', 1, 'admin'),
('2024-12-17 09:50:25', 2, 'nha@arpi.site', '12345678', 'Nasiria Haque', NULL, 'N', 2, 'office'),
('2024-12-20 14:39:32', 3, 'p@gmail.com', '1234', 'Porash Kumar Kabiraj', NULL, 'Y', 3, 'office'),
('2025-02-10 23:35:45', 11, 'inashaque@gmail.com', '$2b$12$o17pldywcX073C3YHmXpCuEOM/mk9x3DJItRNa9VmqTSrHbvH1bBy', 'Nasiria Hoque', 'Onzep International Limited', 'Y', 4, 'office'),
('2026-07-14 20:47:26', 15, 'manager@vesopa.co.uk', '$2b$12$Hx6HPVPyImiEO1jkNnxaq.QYQtBu76dALfvE3S6ah6IwRU6hMXGge', 'Store Manager', NULL, 'Y', 9, 'office');

-- --------------------------------------------------------

--
-- Table structure for table `bo_clarks`
--

CREATE TABLE `bo_clarks` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `email` varchar(255) NOT NULL,
  `pluid` int(11) NOT NULL,
  `clark_name` varchar(255) DEFAULT NULL,
  `pin_code` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `bo_clarks`
--

INSERT INTO `bo_clarks` (`timeadded`, `id`, `email`, `pluid`, `clark_name`, `pin_code`) VALUES
('2025-02-11 09:49:06', 1, 'inashaque@gmail.com', 1, 'Manager', '1234'),
('2025-02-11 09:55:54', 3, 'inashaque@gmail.com', 2, 'Nasiria Hoque', '2342'),
('2026-07-14 20:56:41', 4, 'muzahid@onzep.uk', 0, 'Manager', '1234'),
('2026-07-14 20:56:41', 5, 'muzahid@onzep.uk', 0, 'Sarah', '2345'),
('2026-07-14 20:56:41', 6, 'muzahid@onzep.uk', 0, 'Tom', '3456'),
('2026-07-14 22:33:54', 7, 'manager@vesopa.co.uk', 1, 'Sarah Jones', '1234'),
('2026-07-14 22:33:54', 8, 'manager@vesopa.co.uk', 2, 'Tom Baker', '2345'),
('2026-07-14 22:33:54', 9, 'manager@vesopa.co.uk', 3, 'Priya Patel', '3456'),
('2026-07-14 22:33:54', 10, 'manager@vesopa.co.uk', 4, 'James Wright', '4567');

-- --------------------------------------------------------

--
-- Table structure for table `bo_error_reasons`
--

CREATE TABLE `bo_error_reasons` (
  `id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `reason` varchar(160) NOT NULL,
  `applies_to` varchar(32) NOT NULL DEFAULT 'void',
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `bo_error_reasons`
--

INSERT INTO `bo_error_reasons` (`id`, `office_id`, `reason`, `applies_to`, `sort_order`) VALUES
(1, NULL, 'Customer changed their mind', 'void', 1),
(2, NULL, 'Rung up in error', 'void', 2),
(3, NULL, 'Item returned', 'refund', 3),
(4, NULL, 'Manager discount', 'discount', 4),
(10, NULL, 'Customer changed mind', 'void', 10),
(11, NULL, 'Wrong item rung up', 'void', 11),
(12, NULL, 'Duplicate order', 'void', 12),
(13, NULL, 'Kitchen error', 'void', 13),
(14, NULL, 'Training / test', 'void', 14);

-- --------------------------------------------------------

--
-- Table structure for table `bo_finalise_keys`
--

CREATE TABLE `bo_finalise_keys` (
  `id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `name` varchar(80) NOT NULL,
  `kind` varchar(32) NOT NULL DEFAULT 'cash',
  `opens_drawer` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `bo_finalise_keys`
--

INSERT INTO `bo_finalise_keys` (`id`, `office_id`, `name`, `kind`, `opens_drawer`, `sort_order`) VALUES
(1, NULL, 'Cash', 'cash', 1, 1),
(2, NULL, 'Card', 'card', 0, 2),
(3, NULL, 'Voucher', 'voucher', 0, 3);

-- --------------------------------------------------------

--
-- Table structure for table `bo_mix_match`
--

CREATE TABLE `bo_mix_match` (
  `id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `name` varchar(120) NOT NULL,
  `trigger_qty` int(11) NOT NULL DEFAULT '2',
  `deal_price_minor` int(11) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `bo_mix_match`
--

INSERT INTO `bo_mix_match` (`id`, `office_id`, `name`, `trigger_qty`, `deal_price_minor`, `active`, `sort_order`) VALUES
(1, NULL, '2 Teas for £2.50', 2, 250, 1, 1),
(2, 9, '2 Cocktails for £16', 2, 1600, 1, 2),
(3, 9, 'Any 2 Coffees for £5', 2, 500, 1, 3),
(4, 9, '3 Sides for £10', 3, 1000, 1, 4);

-- --------------------------------------------------------

--
-- Table structure for table `bo_mix_match_products`
--

CREATE TABLE `bo_mix_match_products` (
  `id` int(11) NOT NULL,
  `mix_match_id` int(11) NOT NULL,
  `plu_id` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `bo_mix_match_products`
--

INSERT INTO `bo_mix_match_products` (`id`, `mix_match_id`, `plu_id`) VALUES
(1, 1, 5),
(2, 1, 6),
(3, 1, 7),
(4, 2, 139),
(5, 2, 140),
(6, 2, 141),
(7, 2, 142),
(8, 2, 143),
(9, 3, 108),
(10, 3, 109),
(11, 3, 110),
(12, 3, 111),
(13, 3, 112),
(14, 3, 113),
(15, 3, 114),
(16, 3, 115),
(17, 4, 157),
(18, 4, 158),
(19, 4, 159),
(20, 4, 160);

-- --------------------------------------------------------

--
-- Table structure for table `bo_products`
--

CREATE TABLE `bo_products` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `email` varchar(255) NOT NULL,
  `pluid` int(11) NOT NULL,
  `product_name` varchar(255) DEFAULT NULL,
  `department_name` varchar(255) DEFAULT NULL,
  `group_name` varchar(255) DEFAULT NULL,
  `accounting_code` varchar(255) DEFAULT NULL,
  `price` double DEFAULT NULL,
  `tax_percentage` double DEFAULT NULL,
  `stock_quantity` double DEFAULT NULL,
  `button_position` int(11) DEFAULT NULL,
  `button_color` varchar(16) DEFAULT NULL,
  `printer_route` varchar(32) DEFAULT NULL,
  `emoji` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `image_url` varchar(500) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `bo_products`
--

INSERT INTO `bo_products` (`timeadded`, `id`, `email`, `pluid`, `product_name`, `department_name`, `group_name`, `accounting_code`, `price`, `tax_percentage`, `stock_quantity`, `button_position`, `button_color`, `printer_route`, `emoji`, `image_url`) VALUES
('2025-02-11 15:06:15', 3, 'inashaque@gmail.com', 1, 'Cola', 'Drinks', NULL, NULL, 1.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 4, 'inashaque@gmail.com', 2, 'Orange Juice', 'Drinks', NULL, NULL, 2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 5, 'inashaque@gmail.com', 3, 'Lemonade', 'Drinks', NULL, NULL, 1.8, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 6, 'inashaque@gmail.com', 4, 'Sparkling Water', 'Drinks', NULL, NULL, 1.2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 7, 'inashaque@gmail.com', 5, 'Energy Drink', 'Drinks', NULL, NULL, 2.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 8, 'inashaque@gmail.com', 6, 'Apple Juice', 'Drinks', NULL, NULL, 2.1, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 9, 'inashaque@gmail.com', 7, 'Iced Tea', 'Drinks', NULL, NULL, 1.7, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 10, 'inashaque@gmail.com', 8, 'Ginger Ale', 'Drinks', NULL, NULL, 1.9, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 11, 'inashaque@gmail.com', 9, 'Fruit Punch', 'Drinks', NULL, NULL, 2.3, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 12, 'inashaque@gmail.com', 10, 'Coconut Water', 'Drinks', NULL, NULL, 2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 13, 'inashaque@gmail.com', 11, 'Lemon Iced Tea', 'Drinks', NULL, NULL, 1.6, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 14, 'inashaque@gmail.com', 12, 'Peach Nectar', 'Drinks', NULL, NULL, 2.2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 15, 'inashaque@gmail.com', 13, 'Mineral Water', 'Bottles', NULL, NULL, 0.9, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 16, 'inashaque@gmail.com', 14, 'Soda Water', 'Bottles', NULL, NULL, 1, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 17, 'inashaque@gmail.com', 15, 'Cola', 'Drinks', NULL, NULL, 1.5, 20, 50, 1, '#4BA3F5', 'bar', NULL, NULL),
('2025-02-11 15:06:15', 18, 'inashaque@gmail.com', 16, 'Tonic Water', 'Bottles', NULL, NULL, 1.3, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 19, 'inashaque@gmail.com', 17, 'Red Wine', 'Wines', NULL, NULL, 12, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 20, 'inashaque@gmail.com', 18, 'White Wine', 'Wines', NULL, NULL, 10, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 21, 'inashaque@gmail.com', 19, 'Rosé', 'Wines', NULL, NULL, 11, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 22, 'inashaque@gmail.com', 20, 'Sparkling Wine', 'Wines', NULL, NULL, 14.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 23, 'inashaque@gmail.com', 21, 'Dessert Wine', 'Wines', NULL, NULL, 15, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 24, 'inashaque@gmail.com', 22, 'Vodka', 'Spirits', NULL, NULL, 20, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 25, 'inashaque@gmail.com', 23, 'Whiskey', 'Spirits', NULL, NULL, 25, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 26, 'inashaque@gmail.com', 24, 'Rum', 'Spirits', NULL, NULL, 18, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 27, 'inashaque@gmail.com', 25, 'Tequila', 'Spirits', NULL, NULL, 22, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 28, 'inashaque@gmail.com', 26, 'Gin', 'Spirits', NULL, NULL, 19, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 29, 'inashaque@gmail.com', 27, 'Mojito', 'Cocktails', NULL, NULL, 6, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 30, 'inashaque@gmail.com', 28, 'Margarita', 'Cocktails', NULL, NULL, 6.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 31, 'inashaque@gmail.com', 29, 'Old Fashioned', 'Cocktails', NULL, NULL, 7, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 32, 'inashaque@gmail.com', 30, 'Pina Colada', 'Cocktails', NULL, NULL, 6, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 33, 'inashaque@gmail.com', 31, 'Martini', 'Cocktails', NULL, NULL, 7.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 34, 'inashaque@gmail.com', 32, 'Espresso', 'Coffee', NULL, NULL, 2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 35, 'inashaque@gmail.com', 33, 'Cappuccino', 'Coffee', NULL, NULL, 2.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:15', 36, 'inashaque@gmail.com', 34, 'Latte', 'Coffee', NULL, NULL, 3, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 37, 'inashaque@gmail.com', 35, 'Americano', 'Coffee', NULL, NULL, 2.2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 38, 'inashaque@gmail.com', 36, 'Macchiato', 'Coffee', NULL, NULL, 2.8, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 39, 'inashaque@gmail.com', 37, 'Green Tea', 'Tea', NULL, NULL, 1.5, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 40, 'inashaque@gmail.com', 38, 'Black Tea', 'Tea', NULL, NULL, 1.2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 41, 'inashaque@gmail.com', 39, 'Herbal Tea', 'Tea', NULL, NULL, 1.8, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 42, 'inashaque@gmail.com', 40, 'Chai', 'Tea', NULL, NULL, 2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2025-02-11 15:06:16', 43, 'inashaque@gmail.com', 41, 'Oolong Tea', 'Tea', NULL, NULL, 2.2, 15, 50, NULL, NULL, NULL, NULL, NULL),
('2026-07-14 20:56:41', 44, 'muzahid@onzep.uk', 1, 'Cola', 'Drinks', 'Soft Drinks', NULL, 1.5, 20, 100, 1, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 45, 'muzahid@onzep.uk', 2, 'Orange Juice', 'Drinks', 'Soft Drinks', NULL, 2, 20, 100, 2, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 46, 'muzahid@onzep.uk', 3, 'Lemonade', 'Drinks', 'Soft Drinks', NULL, 1.8, 20, 100, 3, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 47, 'muzahid@onzep.uk', 4, 'Sparkling Water', 'Drinks', 'Soft Drinks', NULL, 1.2, 20, 100, 4, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 48, 'muzahid@onzep.uk', 5, 'Green Tea', 'Tea', 'Hot Drinks', NULL, 1.5, 20, 100, 1, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 49, 'muzahid@onzep.uk', 6, 'Black Tea', 'Tea', 'Hot Drinks', NULL, 1.2, 20, 100, 2, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 50, 'muzahid@onzep.uk', 7, 'Chai', 'Tea', 'Hot Drinks', NULL, 2.2, 20, 100, 3, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 51, 'muzahid@onzep.uk', 8, 'Espresso', 'Coffee', 'Hot Drinks', NULL, 2, 20, 100, 1, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 52, 'muzahid@onzep.uk', 9, 'Latte', 'Coffee', 'Hot Drinks', NULL, 2.8, 20, 100, 2, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 53, 'muzahid@onzep.uk', 10, 'Cappuccino', 'Coffee', 'Hot Drinks', NULL, 2.8, 20, 100, 3, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 20:56:41', 54, 'muzahid@onzep.uk', 11, 'Burger', 'Food', 'Kitchen', NULL, 8.5, 20, 100, 1, '#F4633A', 'kitchen', NULL, NULL),
('2026-07-14 20:56:41', 55, 'muzahid@onzep.uk', 12, 'Fries', 'Food', 'Kitchen', NULL, 3, 20, 100, 2, '#F4633A', 'kitchen', NULL, NULL),
('2026-07-14 20:56:41', 56, 'muzahid@onzep.uk', 13, 'Caesar Salad', 'Food', 'Kitchen', NULL, 7.5, 20, 100, 3, '#F4633A', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 57, 'manager@vesopa.co.uk', 100, 'Coca-Cola', 'Drinks', 'Soft Drinks', NULL, 2.5, 20, 100, 1, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 58, 'manager@vesopa.co.uk', 101, 'Diet Coke', 'Drinks', 'Soft Drinks', NULL, 2.5, 20, 100, 2, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 59, 'manager@vesopa.co.uk', 102, 'Lemonade', 'Drinks', 'Soft Drinks', NULL, 2.3, 20, 100, 3, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 60, 'manager@vesopa.co.uk', 103, 'Orange Juice', 'Drinks', 'Soft Drinks', NULL, 2.8, 20, 100, 4, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 61, 'manager@vesopa.co.uk', 104, 'Apple Juice', 'Drinks', 'Soft Drinks', NULL, 2.8, 20, 100, 5, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 62, 'manager@vesopa.co.uk', 105, 'Sparkling Water', 'Drinks', 'Soft Drinks', NULL, 1.9, 20, 100, 6, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 63, 'manager@vesopa.co.uk', 106, 'Still Water', 'Drinks', 'Soft Drinks', NULL, 1.7, 20, 100, 7, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 64, 'manager@vesopa.co.uk', 107, 'Ginger Beer', 'Drinks', 'Soft Drinks', NULL, 2.9, 20, 100, 8, '#4BA3F5', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 65, 'manager@vesopa.co.uk', 108, 'Espresso', 'Coffee', 'Hot Drinks', NULL, 2.2, 20, 100, 1, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 66, 'manager@vesopa.co.uk', 109, 'Double Espresso', 'Coffee', 'Hot Drinks', NULL, 2.8, 20, 100, 2, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 67, 'manager@vesopa.co.uk', 110, 'Americano', 'Coffee', 'Hot Drinks', NULL, 2.7, 20, 100, 3, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 68, 'manager@vesopa.co.uk', 111, 'Latte', 'Coffee', 'Hot Drinks', NULL, 3.2, 20, 100, 4, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 69, 'manager@vesopa.co.uk', 112, 'Cappuccino', 'Coffee', 'Hot Drinks', NULL, 3.2, 20, 100, 5, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 70, 'manager@vesopa.co.uk', 113, 'Flat White', 'Coffee', 'Hot Drinks', NULL, 3.3, 20, 100, 6, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 71, 'manager@vesopa.co.uk', 114, 'Mocha', 'Coffee', 'Hot Drinks', NULL, 3.6, 20, 100, 7, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 72, 'manager@vesopa.co.uk', 115, 'Hot Chocolate', 'Coffee', 'Hot Drinks', NULL, 3.4, 20, 100, 8, '#8D5524', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 73, 'manager@vesopa.co.uk', 116, 'English Breakfast', 'Tea', 'Hot Drinks', NULL, 2.4, 20, 100, 1, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 74, 'manager@vesopa.co.uk', 117, 'Earl Grey', 'Tea', 'Hot Drinks', NULL, 2.4, 20, 100, 2, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 75, 'manager@vesopa.co.uk', 118, 'Green Tea', 'Tea', 'Hot Drinks', NULL, 2.6, 20, 100, 3, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 76, 'manager@vesopa.co.uk', 119, 'Peppermint', 'Tea', 'Hot Drinks', NULL, 2.6, 20, 100, 4, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 77, 'manager@vesopa.co.uk', 120, 'Chamomile', 'Tea', 'Hot Drinks', NULL, 2.6, 20, 100, 5, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 78, 'manager@vesopa.co.uk', 121, 'Chai Latte', 'Tea', 'Hot Drinks', NULL, 3.4, 20, 100, 6, '#1E9184', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 79, 'manager@vesopa.co.uk', 122, 'Cheeseburger', 'Mains', NULL, NULL, 13.5, 20, 0, NULL, NULL, NULL, '🍔', '/uploads/62bf9485-9819-4055-9631-6a64676ad455.png'),
('2026-07-14 22:33:54', 80, 'manager@vesopa.co.uk', 123, 'Lager Half', 'Beers', 'Alcohol', NULL, 2.8, 20, 100, 2, '#F5B301', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 81, 'manager@vesopa.co.uk', 124, 'IPA Pint', 'Beers', 'Alcohol', NULL, 5.8, 20, 100, 3, '#F5B301', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 82, 'manager@vesopa.co.uk', 125, 'Guinness Pint', 'Beers', 'Alcohol', NULL, 5.6, 20, 100, 4, '#F5B301', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 83, 'manager@vesopa.co.uk', 126, 'Cider Pint', 'Beers', 'Alcohol', NULL, 5.4, 20, 100, 5, '#F5B301', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 84, 'manager@vesopa.co.uk', 127, 'Peroni Bottle', 'Beers', 'Alcohol', NULL, 5, 20, 100, 6, '#F5B301', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 85, 'manager@vesopa.co.uk', 128, 'House Red 175ml', 'Wines', 'Alcohol', NULL, 5.5, 20, 100, 1, '#A435B0', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 86, 'manager@vesopa.co.uk', 129, 'House White 175ml', 'Wines', 'Alcohol', NULL, 5.5, 20, 100, 2, '#A435B0', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 87, 'manager@vesopa.co.uk', 130, 'Rosé 175ml', 'Wines', 'Alcohol', NULL, 5.5, 20, 100, 3, '#A435B0', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 88, 'manager@vesopa.co.uk', 131, 'Prosecco Glass', 'Wines', 'Alcohol', NULL, 6.5, 20, 100, 4, '#A435B0', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 89, 'manager@vesopa.co.uk', 132, 'House Red Bottle', 'Wines', 'Alcohol', NULL, 21, 20, 100, 5, '#A435B0', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 90, 'manager@vesopa.co.uk', 133, 'House White Bottle', 'Wines', 'Alcohol', NULL, 21, 20, 100, 6, '#A435B0', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 91, 'manager@vesopa.co.uk', 134, 'Gin & Tonic', 'Spirits', 'Alcohol', NULL, 7.5, 20, 100, 1, '#2E3A8C', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 92, 'manager@vesopa.co.uk', 135, 'Vodka & Coke', 'Spirits', 'Alcohol', NULL, 7.5, 20, 100, 2, '#2E3A8C', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 93, 'manager@vesopa.co.uk', 136, 'Whisky', 'Spirits', 'Alcohol', NULL, 6.8, 20, 100, 3, '#2E3A8C', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 94, 'manager@vesopa.co.uk', 137, 'Rum & Coke', 'Spirits', 'Alcohol', NULL, 7.2, 20, 100, 4, '#2E3A8C', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 95, 'manager@vesopa.co.uk', 138, 'Tequila Shot', 'Spirits', 'Alcohol', NULL, 4.5, 20, 100, 5, '#2E3A8C', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 96, 'manager@vesopa.co.uk', 139, 'Mojito', 'Cocktails', 'Alcohol', NULL, 9.5, 20, 100, 1, '#F4633A', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 97, 'manager@vesopa.co.uk', 140, 'Espresso Martini', 'Cocktails', 'Alcohol', NULL, 10.5, 20, 100, 2, '#F4633A', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 98, 'manager@vesopa.co.uk', 141, 'Negroni', 'Cocktails', 'Alcohol', NULL, 10, 20, 100, 3, '#F4633A', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 99, 'manager@vesopa.co.uk', 142, 'Aperol Spritz', 'Cocktails', 'Alcohol', NULL, 9, 20, 100, 4, '#F4633A', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 100, 'manager@vesopa.co.uk', 143, 'Old Fashioned', 'Cocktails', 'Alcohol', NULL, 10.5, 20, 100, 5, '#F4633A', 'bar', NULL, NULL),
('2026-07-14 22:33:54', 101, 'manager@vesopa.co.uk', 144, 'Soup of the Day', 'Starters', 'Food', NULL, 6.5, 20, 100, 1, '#7CBB3F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 102, 'manager@vesopa.co.uk', 145, 'Garlic Bread', 'Starters', 'Food', NULL, 4.5, 20, 100, 2, '#7CBB3F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 103, 'manager@vesopa.co.uk', 146, 'Halloumi Fries', 'Starters', 'Food', NULL, 7, 20, 100, 3, '#7CBB3F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 104, 'manager@vesopa.co.uk', 147, 'Chicken Wings', 'Starters', 'Food', NULL, 7.5, 20, 100, 4, '#7CBB3F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 105, 'manager@vesopa.co.uk', 148, 'Bruschetta', 'Starters', 'Food', NULL, 6, 20, 100, 5, '#7CBB3F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 106, 'manager@vesopa.co.uk', 149, 'Cheeseburger', 'Mains', 'Food', NULL, 13.5, 20, 100, 1, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 107, 'manager@vesopa.co.uk', 150, 'Chicken Burger', 'Mains', 'Food', NULL, 13, 20, 100, 2, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 108, 'manager@vesopa.co.uk', 151, 'Veggie Burger', 'Mains', 'Food', NULL, 12.5, 20, 100, 3, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 109, 'manager@vesopa.co.uk', 152, 'Fish & Chips', 'Mains', 'Food', NULL, 14.5, 20, 100, 4, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 110, 'manager@vesopa.co.uk', 153, 'Steak & Chips', 'Mains', 'Food', NULL, 22, 20, 100, 5, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 111, 'manager@vesopa.co.uk', 154, 'Margherita Pizza', 'Mains', 'Food', NULL, 11.5, 20, 100, 6, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 112, 'manager@vesopa.co.uk', 155, 'Pepperoni Pizza', 'Mains', 'Food', NULL, 13, 20, 100, 7, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 113, 'manager@vesopa.co.uk', 156, 'Caesar Salad', 'Mains', 'Food', NULL, 10.5, 20, 100, 8, '#E8412C', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 114, 'manager@vesopa.co.uk', 157, 'Chips', 'Sides', 'Food', NULL, 4, 20, 100, 1, '#3FBBD6', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 115, 'manager@vesopa.co.uk', 158, 'Sweet Potato Fries', 'Sides', 'Food', NULL, 4.8, 20, 100, 2, '#3FBBD6', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 116, 'manager@vesopa.co.uk', 159, 'Onion Rings', 'Sides', 'Food', NULL, 4.5, 20, 100, 3, '#3FBBD6', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 117, 'manager@vesopa.co.uk', 160, 'Side Salad', 'Sides', 'Food', NULL, 3.8, 20, 100, 4, '#3FBBD6', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 118, 'manager@vesopa.co.uk', 161, 'Sticky Toffee Pudding', 'Desserts', 'Food', NULL, 7, 20, 100, 1, '#A4308F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 119, 'manager@vesopa.co.uk', 162, 'Cheesecake', 'Desserts', 'Food', NULL, 6.8, 20, 100, 2, '#A4308F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 120, 'manager@vesopa.co.uk', 163, 'Chocolate Brownie', 'Desserts', 'Food', NULL, 6.5, 20, 100, 3, '#A4308F', 'kitchen', NULL, NULL),
('2026-07-14 22:33:54', 121, 'manager@vesopa.co.uk', 164, 'Ice Cream', 'Desserts', 'Food', NULL, 5, 20, 100, 4, '#A4308F', 'kitchen', NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `bo_product_departments`
--

CREATE TABLE `bo_product_departments` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `email` varchar(255) NOT NULL,
  `pluid` int(11) NOT NULL,
  `department_name` varchar(255) DEFAULT NULL,
  `group_name` varchar(255) DEFAULT NULL,
  `accounting_code` varchar(255) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `bo_product_departments`
--

INSERT INTO `bo_product_departments` (`timeadded`, `id`, `email`, `pluid`, `department_name`, `group_name`, `accounting_code`, `sort_order`) VALUES
('2025-02-11 07:25:43', 1, 'inashaque@gmail.com', 1, 'Drinks', 'Drink', '1556', 3),
('2025-02-11 07:56:24', 2, 'inashaque@gmail.com', 2, 'Beers', 'Drink', '2552', 2),
('2025-02-11 14:57:34', 7, 'inashaque@gmail.com', 3, 'Bottles', 'Drink', '', 1),
('2025-02-11 14:57:43', 8, 'inashaque@gmail.com', 4, 'Wines', 'Drink', '', 8),
('2025-02-11 14:57:51', 9, 'inashaque@gmail.com', 5, 'Spirits', 'Drink', '', 9),
('2025-02-11 14:57:59', 10, 'inashaque@gmail.com', 6, 'Cocktails', 'Drink', '', 10),
('2025-02-11 14:58:12', 11, 'inashaque@gmail.com', 7, 'Coffee', 'Drink', '', 11),
('2025-02-11 14:58:20', 12, 'inashaque@gmail.com', 8, 'Tea', 'Drink', '', 12),
('2026-07-14 22:33:54', 20, 'manager@vesopa.co.uk', 0, 'Starters', 'Food', NULL, 20),
('2026-07-14 22:33:54', 21, 'manager@vesopa.co.uk', 0, 'Mains', 'Food', NULL, 21),
('2026-07-14 22:33:54', 22, 'manager@vesopa.co.uk', 0, 'Sides', 'Food', NULL, 22),
('2026-07-14 22:33:54', 23, 'manager@vesopa.co.uk', 0, 'Desserts', 'Food', NULL, 23);

-- --------------------------------------------------------

--
-- Table structure for table `bo_product_groups`
--

CREATE TABLE `bo_product_groups` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `email` varchar(255) NOT NULL,
  `pluid` int(11) NOT NULL,
  `group_name` varchar(255) DEFAULT NULL,
  `accounting_code` varchar(255) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `bo_product_groups`
--

INSERT INTO `bo_product_groups` (`timeadded`, `id`, `email`, `pluid`, `group_name`, `accounting_code`, `sort_order`) VALUES
('2025-02-11 06:45:28', 2, 'inashaque@gmail.com', 2, 'Drink', '3447', 2),
('2025-02-11 07:13:56', 5, 'inashaque@gmail.com', 3, 'Promotional', '2551', 5),
('2025-02-11 08:00:04', 6, 'inashaque@gmail.com', 4, 'Food', '', 6),
('2026-07-14 22:33:54', 7, 'manager@vesopa.co.uk', 0, 'Soft Drinks', NULL, 7),
('2026-07-14 22:33:54', 8, 'manager@vesopa.co.uk', 0, 'Hot Drinks', NULL, 8),
('2026-07-14 22:33:54', 10, 'manager@vesopa.co.uk', 0, 'Alcohol', NULL, 10);

-- --------------------------------------------------------

--
-- Table structure for table `bo_tax_rates`
--

CREATE TABLE `bo_tax_rates` (
  `id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `name` varchar(80) NOT NULL,
  `percentage` double NOT NULL DEFAULT '0',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `bo_tax_rates`
--

INSERT INTO `bo_tax_rates` (`id`, `office_id`, `name`, `percentage`, `is_default`, `sort_order`) VALUES
(1, NULL, 'Standard VAT', 20, 1, 1),
(2, NULL, 'Reduced VAT', 5, 0, 2),
(3, NULL, 'Zero rated', 0, 0, 3);

-- --------------------------------------------------------

--
-- Table structure for table `bo_vouchers`
--

CREATE TABLE `bo_vouchers` (
  `id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `code` varchar(60) NOT NULL,
  `name` varchar(120) NOT NULL,
  `discount_type` varchar(16) NOT NULL DEFAULT 'percent',
  `value` int(11) NOT NULL DEFAULT '0',
  `expires_on` date DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int(11) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `bo_vouchers`
--

INSERT INTO `bo_vouchers` (`id`, `office_id`, `code`, `name`, `discount_type`, `value`, `expires_on`, `active`, `sort_order`) VALUES
(1, 9, 'WELCOME10', 'Welcome 10% off', 'percent', 10, NULL, 1, 1),
(2, 9, 'STAFF25', 'Staff discount', 'percent', 25, NULL, 1, 2),
(3, 9, 'FIVER', '£5 off', 'amount', 500, NULL, 1, 3);

-- --------------------------------------------------------

--
-- Table structure for table `career_request`
--

CREATE TABLE `career_request` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `phone` varchar(255) DEFAULT NULL,
  `company` varchar(512) DEFAULT NULL,
  `description` varchar(2000) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `career_request`
--

INSERT INTO `career_request` (`timeadded`, `id`, `name`, `email`, `phone`, `company`, `description`) VALUES
('2025-02-10 20:19:37', 1, 'Nasiria Haque', 'anzanaahiya@gmail.com', '07456289388', 'Onzep International Limited', 'Graphics Designer'),
('2025-02-10 20:36:47', 2, 'Muzahid Islam', 'muzahidi221@gmail.com', '+8801714526039', 'Onzep International Limited', 'Described my Job as Software Engineer'),
('2025-02-10 20:47:13', 4, 'Muzahid Islam', 'muzahidi221@gmail.com', '+8801714526039', 'Onzep International Limited', 'Described my Job as Software Engineer');

-- --------------------------------------------------------

--
-- Table structure for table `customer_message`
--

CREATE TABLE `customer_message` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `phone` varchar(255) DEFAULT NULL,
  `message` varchar(5000) DEFAULT NULL,
  `comment` varchar(1000) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `customer_message`
--

INSERT INTO `customer_message` (`timeadded`, `id`, `name`, `email`, `phone`, `message`, `comment`) VALUES
('2025-02-10 18:40:14', 1, 'Nasiria Hoque', 'inashaque@gmail.com', '07456289388', 'I want to use this test email', 'My comment Here'),
('2025-02-10 18:50:25', 3, 'Nasiria Hoque', 'inashaque@gmail.com', '07456289388', 'I want to use this test email', 'My comment Here'),
('2025-02-10 18:52:01', 4, 'Nasiria Hoque', 'inashaque@gmail.com', '07456289388', 'I want to use this test email', 'My comment Here'),
('2025-02-10 19:30:55', 7, 'Nasiria Hoque', 'inashaque@gmail.com', '07456289388', 'Anything Please', 'My Sober Comment');

-- --------------------------------------------------------

--
-- Table structure for table `demo_request`
--

CREATE TABLE `demo_request` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `phone` varchar(255) DEFAULT NULL,
  `business_name` varchar(512) DEFAULT NULL,
  `business_brief` varchar(2000) DEFAULT NULL,
  `approved` enum('Y','N') DEFAULT 'N'
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `demo_request`
--

INSERT INTO `demo_request` (`timeadded`, `id`, `name`, `email`, `phone`, `business_name`, `business_brief`, `approved`) VALUES
('2025-02-10 19:28:35', 2, 'Nasiria Hoque', 'inashaque@gmail.com', '07456289388', 'Onzep International Limited', 'Software Company who is developing the software of Vesopa EPOS', 'Y');

-- --------------------------------------------------------

--
-- Table structure for table `epos_customers`
--

CREATE TABLE `epos_customers` (
  `id` char(36) NOT NULL,
  `email_key` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `phone` varchar(64) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `card_number` varchar(64) DEFAULT NULL,
  `discount_type` enum('none','percent','amount') NOT NULL DEFAULT 'none',
  `discount_value` int(11) NOT NULL DEFAULT '0',
  `points_balance` int(11) NOT NULL DEFAULT '0',
  `membership_expiry` date DEFAULT NULL,
  `notes` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------

--
-- Table structure for table `epos_orders`
--

CREATE TABLE `epos_orders` (
  `id` char(36) NOT NULL,
  `email` varchar(255) NOT NULL,
  `table_number` int(11) DEFAULT NULL,
  `clerk_pin` varchar(255) DEFAULT NULL,
  `subtotal_minor` int(11) NOT NULL DEFAULT '0',
  `discount_minor` int(11) NOT NULL DEFAULT '0',
  `tax_minor` int(11) NOT NULL DEFAULT '0',
  `total_minor` int(11) NOT NULL DEFAULT '0',
  `closed_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `covers` int(11) DEFAULT NULL,
  `notes` varchar(500) DEFAULT NULL,
  `customer_name` varchar(255) DEFAULT NULL,
  `session_id` char(36) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `epos_orders`
--

INSERT INTO `epos_orders` (`id`, `email`, `table_number`, `clerk_pin`, `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`, `closed_at`, `created_at`, `covers`, `notes`, `customer_name`, `session_id`) VALUES
('21237572-c099-468b-8eac-36276d3a40b6', 'manager@vesopa.co.uk', 7, NULL, 1420, 0, 237, 1420, '2026-07-18 13:30:12', '2026-07-18 07:30:13', NULL, NULL, NULL, 'a8cb759e-52ab-4675-ba39-4e1f8bda3fc8'),
('33677cab-f5a4-41d9-9f59-fad129550d9d', 'manager@vesopa.co.uk', NULL, NULL, 520, 0, 87, 520, '2026-07-15 05:23:21', '2026-07-14 23:23:26', NULL, NULL, NULL, 'a8cb759e-52ab-4675-ba39-4e1f8bda3fc8'),
('3f30630a-a297-4780-8db3-9ec8cfda4873', 'manager@vesopa.co.uk', NULL, NULL, 860, 0, 144, 860, '2026-07-15 06:07:55', '2026-07-15 00:07:56', NULL, NULL, NULL, 'a8cb759e-52ab-4675-ba39-4e1f8bda3fc8'),
('643d13cc-de49-4ca3-9679-b302b691a8f2', 'manager@vesopa.co.uk', NULL, NULL, 1340, 0, 223, 1340, '2026-07-18 10:48:52', '2026-07-18 04:48:53', NULL, NULL, NULL, 'a8cb759e-52ab-4675-ba39-4e1f8bda3fc8'),
('6eea878a-9369-42b1-ab94-a6ad82a3a2c0', 'manager@vesopa.co.uk', 1, NULL, 280, 0, 47, 280, '2026-07-15 06:40:25', '2026-07-15 00:40:25', NULL, NULL, NULL, 'a8cb759e-52ab-4675-ba39-4e1f8bda3fc8'),
('91b333bb-ea17-4ef3-b586-0fdf002004ca', 'muzahid@onzep.uk', NULL, NULL, 280, 0, 47, 280, '2026-07-15 03:29:52', '2026-07-14 21:30:09', NULL, NULL, NULL, 'b74897c9-6934-4302-ab8a-935756217ec5'),
('b86c38f2-2658-4471-9624-ad8dd634de25', 'manager@vesopa.co.uk', NULL, NULL, 520, 0, 87, 520, '2026-07-15 05:30:34', '2026-07-14 23:30:43', NULL, NULL, NULL, 'a8cb759e-52ab-4675-ba39-4e1f8bda3fc8'),
('rcpt-test-1', 'manager@vesopa.co.uk', 5, NULL, 1750, 0, 292, 1750, '2026-07-15 21:00:00', '2026-07-14 23:36:22', NULL, NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `epos_order_lines`
--

CREATE TABLE `epos_order_lines` (
  `id` char(36) NOT NULL,
  `order_id` char(36) NOT NULL,
  `plu_id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `quantity` double NOT NULL DEFAULT '1',
  `unit_price_minor` int(11) NOT NULL,
  `tax_percentage` double NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `epos_order_lines`
--

INSERT INTO `epos_order_lines` (`id`, `order_id`, `plu_id`, `name`, `quantity`, `unit_price_minor`, `tax_percentage`) VALUES
('03dedae0-7fdb-11f1-9e06-d7017b6690a1', '33677cab-f5a4-41d9-9f59-fad129550d9d', 122, 'Lager Pint', 1, 520, 20),
('085ff7a6-7fdc-11f1-9e06-d7017b6690a1', 'b86c38f2-2658-4471-9624-ad8dd634de25', 122, 'Lager Pint', 1, 520, 20),
('30637860-7fcb-11f1-9e06-d7017b6690a1', '91b333bb-ea17-4ef3-b586-0fdf002004ca', 9, 'Latte', 1, 280, 20),
('3b4ae41e-7fe1-11f1-9e06-d7017b6690a1', '3f30630a-a297-4780-8db3-9ec8cfda4873', 123, 'Lager Half', 1, 280, 20),
('3b4afc38-7fe1-11f1-9e06-d7017b6690a1', '3f30630a-a297-4780-8db3-9ec8cfda4873', 124, 'IPA Pint', 1, 580, 20),
('83b0a842-827a-11f1-9e06-d7017b6690a1', '21237572-c099-468b-8eac-36276d3a40b6', 123, 'Lager Half', 1, 280, 20),
('83b0cf5c-827a-11f1-9e06-d7017b6690a1', '21237572-c099-468b-8eac-36276d3a40b6', 124, 'IPA Pint', 1, 580, 20),
('83b35bfa-827a-11f1-9e06-d7017b6690a1', '21237572-c099-468b-8eac-36276d3a40b6', 125, 'Guinness Pint', 1, 560, 20),
('c51c64b6-7fe5-11f1-9e06-d7017b6690a1', '6eea878a-9369-42b1-ab94-a6ad82a3a2c0', 123, 'Lager Half', 1, 280, 20),
('d24276ca-7fdc-11f1-9e06-d7017b6690a1', 'rcpt-test-1', 100, 'Cheeseburger', 1, 1350, 20),
('d24298bc-7fdc-11f1-9e06-d7017b6690a1', 'rcpt-test-1', 140, 'Chips', 1, 400, 20),
('fa05b9cc-8263-11f1-9e06-d7017b6690a1', '643d13cc-de49-4ca3-9679-b302b691a8f2', 127, 'Peroni Bottle', 1, 500, 20),
('fa05d60a-8263-11f1-9e06-d7017b6690a1', '643d13cc-de49-4ca3-9679-b302b691a8f2', 125, 'Guinness Pint', 1, 560, 20),
('fa05ec9e-8263-11f1-9e06-d7017b6690a1', '643d13cc-de49-4ca3-9679-b302b691a8f2', 123, 'Lager Half', 1, 280, 20);

-- --------------------------------------------------------

--
-- Table structure for table `epos_payments`
--

CREATE TABLE `epos_payments` (
  `id` char(36) NOT NULL,
  `order_id` char(36) NOT NULL,
  `method` varchar(32) NOT NULL,
  `amount_minor` int(11) NOT NULL,
  `taken_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `epos_payments`
--

INSERT INTO `epos_payments` (`id`, `order_id`, `method`, `amount_minor`, `taken_at`) VALUES
('03df1fb4-7fdb-11f1-9e06-d7017b6690a1', '33677cab-f5a4-41d9-9f59-fad129550d9d', 'cash', 1000, '2026-07-14 23:23:26'),
('08601812-7fdc-11f1-9e06-d7017b6690a1', 'b86c38f2-2658-4471-9624-ad8dd634de25', 'cash', 520, '2026-07-14 23:30:43'),
('30639354-7fcb-11f1-9e06-d7017b6690a1', '91b333bb-ea17-4ef3-b586-0fdf002004ca', 'cash', 1000, '2026-07-14 21:30:09'),
('3b4b9b16-7fe1-11f1-9e06-d7017b6690a1', '3f30630a-a297-4780-8db3-9ec8cfda4873', 'cash', 1000, '2026-07-15 00:07:56'),
('83b37482-827a-11f1-9e06-d7017b6690a1', '21237572-c099-468b-8eac-36276d3a40b6', 'cash', 1420, '2026-07-18 07:30:13'),
('c51c717c-7fe5-11f1-9e06-d7017b6690a1', '6eea878a-9369-42b1-ab94-a6ad82a3a2c0', 'cash', 2000, '2026-07-15 00:40:25'),
('d242dc64-7fdc-11f1-9e06-d7017b6690a1', 'rcpt-test-1', 'card', 1750, '2026-07-14 23:36:22'),
('fa0631ea-8263-11f1-9e06-d7017b6690a1', '643d13cc-de49-4ca3-9679-b302b691a8f2', 'cash', 1340, '2026-07-18 04:48:53');

-- --------------------------------------------------------

--
-- Table structure for table `epos_void_log`
--

CREATE TABLE `epos_void_log` (
  `id` char(36) NOT NULL,
  `email` varchar(255) NOT NULL,
  `order_id` char(36) DEFAULT NULL,
  `clerk_pin` varchar(255) DEFAULT NULL,
  `reason` varchar(255) NOT NULL,
  `amount_minor` int(11) NOT NULL DEFAULT '0',
  `voided_at` datetime NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `epos_void_log`
--

INSERT INTO `epos_void_log` (`id`, `email`, `order_id`, `clerk_pin`, `reason`, `amount_minor`, `voided_at`, `created_at`) VALUES
('void-test-1', 'manager@vesopa.co.uk', 'o1', NULL, 'Wrong item rung up', 1350, '2026-07-15 20:00:00', '2026-07-14 23:27:05');

-- --------------------------------------------------------

--
-- Table structure for table `floor_rooms`
--

CREATE TABLE `floor_rooms` (
  `id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `name` varchar(120) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `floor_rooms`
--

INSERT INTO `floor_rooms` (`id`, `office_id`, `name`, `sort_order`, `created_at`) VALUES
(1, NULL, 'Main Floor', 0, '2026-07-14 20:33:30'),
(2, 9, 'Main Floor', 0, '2026-07-14 22:33:54'),
(3, 9, 'Terrace', 0, '2026-07-14 22:33:54');

-- --------------------------------------------------------

--
-- Table structure for table `floor_tables`
--

CREATE TABLE `floor_tables` (
  `id` int(11) NOT NULL,
  `room_id` int(11) NOT NULL,
  `office_id` int(11) DEFAULT NULL,
  `table_number` int(11) NOT NULL,
  `label` varchar(60) DEFAULT NULL,
  `pos_x` int(11) NOT NULL DEFAULT '0',
  `pos_y` int(11) NOT NULL DEFAULT '0',
  `width` int(11) NOT NULL DEFAULT '2',
  `height` int(11) NOT NULL DEFAULT '2',
  `shape` enum('rect','circle') NOT NULL DEFAULT 'rect',
  `seats` int(11) NOT NULL DEFAULT '4'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `floor_tables`
--

INSERT INTO `floor_tables` (`id`, `room_id`, `office_id`, `table_number`, `label`, `pos_x`, `pos_y`, `width`, `height`, `shape`, `seats`) VALUES
(1, 1, NULL, 1, 'Window', 4, 4, 3, 2, 'circle', 6),
(2, 1, NULL, 2, NULL, 2, 1, 2, 2, 'rect', 4),
(3, 1, NULL, 3, NULL, 5, 1, 2, 2, 'rect', 4),
(6, 2, 9, 1, NULL, 1, 1, 2, 2, 'rect', 4),
(7, 2, 9, 2, NULL, 4, 1, 2, 2, 'rect', 4),
(8, 2, 9, 3, NULL, 7, 1, 2, 2, 'rect', 4),
(9, 2, 9, 4, NULL, 10, 1, 3, 2, 'rect', 6),
(10, 2, 9, 5, NULL, 1, 4, 2, 2, 'circle', 2),
(11, 2, 9, 6, NULL, 4, 4, 2, 2, 'circle', 2),
(12, 2, 9, 7, NULL, 7, 4, 3, 3, 'circle', 8),
(13, 2, 9, 8, NULL, 11, 4, 2, 2, 'rect', 4),
(14, 2, 9, 9, NULL, 1, 7, 3, 2, 'rect', 6),
(15, 2, 9, 10, NULL, 5, 7, 3, 2, 'rect', 6),
(16, 3, 9, 21, NULL, 1, 1, 2, 2, 'circle', 4),
(17, 3, 9, 22, NULL, 4, 1, 2, 2, 'circle', 4),
(18, 3, 9, 23, NULL, 7, 1, 2, 2, 'circle', 4),
(19, 3, 9, 24, NULL, 1, 4, 3, 2, 'rect', 6),
(20, 3, 9, 25, NULL, 5, 4, 3, 2, 'rect', 6);

-- --------------------------------------------------------

--
-- Table structure for table `offices`
--

CREATE TABLE `offices` (
  `id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `contact_email` varchar(255) NOT NULL,
  `status` enum('active','paused','archived') NOT NULL DEFAULT 'active',
  `plan` varchar(64) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `paused_at` datetime DEFAULT NULL,
  `pause_reason` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Dumping data for table `offices`
--

INSERT INTO `offices` (`id`, `name`, `contact_email`, `status`, `plan`, `created_at`, `paused_at`, `pause_reason`) VALUES
(1, 'Md Muzahidul Islam', 'muzahid@onzep.uk', 'active', NULL, '2026-07-14 20:17:22', NULL, NULL),
(2, 'Nasiria Haque', 'nha@arpi.site', 'active', NULL, '2026-07-14 20:17:22', NULL, NULL),
(3, 'Porash Kumar Kabiraj', 'p@gmail.com', 'active', NULL, '2026-07-14 20:17:22', NULL, NULL),
(4, 'Onzep International Limited', 'inashaque@gmail.com', 'active', NULL, '2026-07-14 20:17:22', NULL, NULL),
(9, 'The Vesopa Kitchen', 'manager@vesopa.co.uk', 'active', 'Standard', '2026-07-14 22:33:46', NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `subscriptions`
--

CREATE TABLE `subscriptions` (
  `id` int(11) NOT NULL,
  `office_id` int(11) NOT NULL,
  `amount_minor` int(11) NOT NULL DEFAULT '0',
  `currency` char(3) NOT NULL DEFAULT 'GBP',
  `interval_unit` enum('month','year') NOT NULL DEFAULT 'month',
  `next_due_on` date NOT NULL,
  `status` enum('active','cancelled') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------

--
-- Table structure for table `subscription_invoices`
--

CREATE TABLE `subscription_invoices` (
  `id` int(11) NOT NULL,
  `subscription_id` int(11) NOT NULL,
  `office_id` int(11) NOT NULL,
  `amount_minor` int(11) NOT NULL,
  `due_on` date NOT NULL,
  `paid_at` datetime DEFAULT NULL,
  `status` enum('due','paid','overdue') NOT NULL DEFAULT 'due',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------

--
-- Table structure for table `training_request`
--

CREATE TABLE `training_request` (
  `timeadded` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `id` int(11) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `phone` varchar(255) DEFAULT NULL,
  `company` varchar(512) DEFAULT NULL,
  `booking_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `message` varchar(2000) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Dumping data for table `training_request`
--

INSERT INTO `training_request` (`timeadded`, `id`, `name`, `email`, `phone`, `company`, `booking_time`, `message`) VALUES
('2025-02-10 21:15:05', 1, 'Nasiria Hoque', 'inashaque@gmail.com', '07456289388', 'Onzep International Limited', '2025-02-11 00:19:00', '17 Glidden Close'),
('2025-02-10 22:03:32', 2, 'Masudur Rahman', 'anzanaahiya@gmail.com', '07456289388', 'Vesopa EPOS Store', '2025-02-13 22:06:00', '17 Glidden Close');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admin_table`
--
ALTER TABLE `admin_table`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`);

--
-- Indexes for table `backoffice_users`
--
ALTER TABLE `backoffice_users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Indexes for table `bo_clarks`
--
ALTER TABLE `bo_clarks`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bo_error_reasons`
--
ALTER TABLE `bo_error_reasons`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bo_finalise_keys`
--
ALTER TABLE `bo_finalise_keys`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bo_mix_match`
--
ALTER TABLE `bo_mix_match`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bo_mix_match_products`
--
ALTER TABLE `bo_mix_match_products`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_mm_plu` (`mix_match_id`,`plu_id`);

--
-- Indexes for table `bo_products`
--
ALTER TABLE `bo_products`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bo_product_departments`
--
ALTER TABLE `bo_product_departments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `department_name` (`department_name`);

--
-- Indexes for table `bo_product_groups`
--
ALTER TABLE `bo_product_groups`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `group_name` (`group_name`);

--
-- Indexes for table `bo_tax_rates`
--
ALTER TABLE `bo_tax_rates`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `bo_vouchers`
--
ALTER TABLE `bo_vouchers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_voucher_code` (`office_id`,`code`);

--
-- Indexes for table `career_request`
--
ALTER TABLE `career_request`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `customer_message`
--
ALTER TABLE `customer_message`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `demo_request`
--
ALTER TABLE `demo_request`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Indexes for table `epos_customers`
--
ALTER TABLE `epos_customers`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_cust_office` (`email_key`),
  ADD KEY `idx_cust_phone` (`email_key`,`phone`);

--
-- Indexes for table `epos_orders`
--
ALTER TABLE `epos_orders`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_orders_email_closed` (`email`,`closed_at`);

--
-- Indexes for table `epos_order_lines`
--
ALTER TABLE `epos_order_lines`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_lines_order` (`order_id`);

--
-- Indexes for table `epos_payments`
--
ALTER TABLE `epos_payments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_payments_order` (`order_id`);

--
-- Indexes for table `epos_void_log`
--
ALTER TABLE `epos_void_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_void_email_time` (`email`,`voided_at`);

--
-- Indexes for table `floor_rooms`
--
ALTER TABLE `floor_rooms`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_rooms_office` (`office_id`);

--
-- Indexes for table `floor_tables`
--
ALTER TABLE `floor_tables`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_room_table` (`room_id`,`table_number`),
  ADD KEY `idx_tables_room` (`room_id`);

--
-- Indexes for table `offices`
--
ALTER TABLE `offices`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_offices_email` (`contact_email`);

--
-- Indexes for table `subscriptions`
--
ALTER TABLE `subscriptions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_sub_office` (`office_id`),
  ADD KEY `idx_sub_due` (`status`,`next_due_on`);

--
-- Indexes for table `subscription_invoices`
--
ALTER TABLE `subscription_invoices`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_inv_sub` (`subscription_id`),
  ADD KEY `fk_inv_office` (`office_id`),
  ADD KEY `idx_inv_status` (`status`,`due_on`);

--
-- Indexes for table `training_request`
--
ALTER TABLE `training_request`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admin_table`
--
ALTER TABLE `admin_table`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;

--
-- AUTO_INCREMENT for table `backoffice_users`
--
ALTER TABLE `backoffice_users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=16;

--
-- AUTO_INCREMENT for table `bo_clarks`
--
ALTER TABLE `bo_clarks`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=11;

--
-- AUTO_INCREMENT for table `bo_error_reasons`
--
ALTER TABLE `bo_error_reasons`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=15;

--
-- AUTO_INCREMENT for table `bo_finalise_keys`
--
ALTER TABLE `bo_finalise_keys`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `bo_mix_match`
--
ALTER TABLE `bo_mix_match`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `bo_mix_match_products`
--
ALTER TABLE `bo_mix_match_products`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=21;

--
-- AUTO_INCREMENT for table `bo_products`
--
ALTER TABLE `bo_products`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=122;

--
-- AUTO_INCREMENT for table `bo_product_departments`
--
ALTER TABLE `bo_product_departments`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=24;

--
-- AUTO_INCREMENT for table `bo_product_groups`
--
ALTER TABLE `bo_product_groups`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=18;

--
-- AUTO_INCREMENT for table `bo_tax_rates`
--
ALTER TABLE `bo_tax_rates`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `bo_vouchers`
--
ALTER TABLE `bo_vouchers`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `career_request`
--
ALTER TABLE `career_request`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `customer_message`
--
ALTER TABLE `customer_message`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `demo_request`
--
ALTER TABLE `demo_request`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `floor_rooms`
--
ALTER TABLE `floor_rooms`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `floor_tables`
--
ALTER TABLE `floor_tables`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=21;

--
-- AUTO_INCREMENT for table `offices`
--
ALTER TABLE `offices`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `subscriptions`
--
ALTER TABLE `subscriptions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `subscription_invoices`
--
ALTER TABLE `subscription_invoices`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `training_request`
--
ALTER TABLE `training_request`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `bo_mix_match_products`
--
ALTER TABLE `bo_mix_match_products`
  ADD CONSTRAINT `fk_mm` FOREIGN KEY (`mix_match_id`) REFERENCES `bo_mix_match` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `epos_order_lines`
--
ALTER TABLE `epos_order_lines`
  ADD CONSTRAINT `fk_lines_order` FOREIGN KEY (`order_id`) REFERENCES `epos_orders` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `epos_payments`
--
ALTER TABLE `epos_payments`
  ADD CONSTRAINT `fk_payments_order` FOREIGN KEY (`order_id`) REFERENCES `epos_orders` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `floor_tables`
--
ALTER TABLE `floor_tables`
  ADD CONSTRAINT `fk_table_room` FOREIGN KEY (`room_id`) REFERENCES `floor_rooms` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `subscriptions`
--
ALTER TABLE `subscriptions`
  ADD CONSTRAINT `fk_sub_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `subscription_invoices`
--
ALTER TABLE `subscription_invoices`
  ADD CONSTRAINT `fk_inv_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_inv_sub` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
